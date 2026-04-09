import os
import math
import random
import requests
from flask import Flask, render_template, request, jsonify
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
MAPS_API_KEY = os.getenv('GOOGlE_MAPS_API_KEY', os.getenv('GOOGLE_MAPS_API_KEY'))

@app.route('/')
def index():
    return render_template('index.html', maps_api_key=MAPS_API_KEY)

def calculate_distance(lat1, lon1, lat2, lon2):
    """２点間の直線距離(km)を計算"""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2)**2 + \
        math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c

def get_directions_from_google(points):
    """Google Directions APIを呼び出し、歩行ルートを取得する"""
    if len(points) < 2: return None
    
    origin = f"{points[0]['lat']},{points[0]['lng']}"
    destination = f"{points[-1]['lat']},{points[-1]['lng']}"
    waypoints = [f"{p['lat']},{p['lng']}" for p in points[1:-1]] if len(points) > 2 else []
        
    url = "https://maps.googleapis.com/maps/api/directions/json"
    params = {
        'origin': origin,
        'destination': destination,
        'mode': 'walking',
        'key': MAPS_API_KEY
    }
    if waypoints:
        params['waypoints'] = "|".join(waypoints)
        
    response = requests.get(url, params=params)
    return response.json()

def get_elevation_gain(polyline_str):
    """Google Elevation APIを用いてルートの総上昇量(m)を計算する"""
    url = "https://maps.googleapis.com/maps/api/elevation/json"
    params = {
        'path': f"enc:{polyline_str}",
        'samples': 50, # API使用量やパフォーマンスの観点で50点ほどにサンプリング
        'key': MAPS_API_KEY
    }
    resp = requests.get(url, params=params)
    data = resp.json()
    if data.get('status') != 'OK':
        return 0
    results = data.get('results', [])
    gain = 0.0
    for i in range(1, len(results)):
        diff = results[i]['elevation'] - results[i-1]['elevation']
        if diff > 0:
            gain += diff
    return gain

@app.route('/api/generate_route', methods=['POST'])
def generate_route():
    data = request.json
    points = data.get('points', [])
    desired_distance = data.get('desired_distance', 0)
    elevation_pref = data.get('elevation_preference', 'any')
    
    if len(points) < 2:
        return jsonify({'error': '開始地点と終了地点が必要です'}), 400
        
    start = points[0]
    end = points[-1]
    D = calculate_distance(start['lat'], start['lng'], end['lat'], end['lng'])

    candidates = []

    # ランダム性を担保するため、3個の異なる迂回ルートを生成して比較する
    for attempt in range(3):
        modified_points = list(points)
        
        # 希望距離(L)と直線距離(D)から、楕円の短軸の高さを求める基準オフセットを計算
        if desired_distance > D:
            # 万が一Dが0に近い時のゼロ割りを防ぐ
            base_L = desired_distance if desired_distance > 0.1 else 0.1
            base_D = D if D > 0 else 0.01
            # sqrtの中身がマイナスにならないように
            val = (base_L / 2.0)**2 - (base_D / 2.0)**2
            h_km = math.sqrt(val) if val > 0 else 0.1
            offset_deg = h_km / 111.0 
        else:
            # 距離が足りている場合でもランダムな揺らぎ（1〜2kmのブレ）を加える
            offset_deg = random.uniform(0.005, 0.02)
            
        # 完全なランダム性を追加：オフセット量にブレ(0.6倍〜1.5倍)と、左右どちら側かのランダム反転を付与
        side_multiplier = random.choice([-1, 1])
        fuzz = random.uniform(0.6, 1.5)
        final_offset_deg = offset_deg * fuzz * side_multiplier
        
        # 垂直ベクトルを求めて中間地点にオフセット適用
        mid_lat = (start['lat'] + end['lat']) / 2.0
        mid_lng = (start['lng'] + end['lng']) / 2.0
        
        dlat = end['lat'] - start['lat']
        dlng = end['lng'] - start['lng']
        length = math.hypot(-dlng, dlat) or 1
        perp_lat = -dlng / length
        perp_lng = dlat / length
        
        auto_waypoint = {
            'lat': mid_lat + perp_lat * final_offset_deg,
            'lng': mid_lng + perp_lng * final_offset_deg
        }
        modified_points.insert(-1, auto_waypoint)
        
        res = get_directions_from_google(modified_points)
        if res and res.get('status') == 'OK' and res.get('routes'):
            r = res['routes'][0]
            total_distance_meters = sum([leg['distance']['value'] for leg in r['legs']])
            candidates.append({
                'route': r,
                'distance': total_distance_meters,
                'points': modified_points
            })

    if not candidates:
        return jsonify({'error': '条件に合うルートが見つかりませんでした'}), 404

    # Elevation APIで各ルートの高低差を計算
    for cand in candidates:
        cand['elevation_gain'] = get_elevation_gain(cand['route']['overview_polyline']['points'])
        
    # 高低差のオプションに基づいて候補をソート
    if elevation_pref == 'flat':
        candidates.sort(key=lambda x: x['elevation_gain']) # 上昇量が少ない順
    elif elevation_pref == 'hilly':
        candidates.sort(key=lambda x: x['elevation_gain'], reverse=True) # 上昇量が多い順
    else:
        random.shuffle(candidates) # 気にしない場合は完全ランダムに選択
        
    best_candidate = candidates[0]

    return jsonify({
        'polyline': best_candidate['route']['overview_polyline']['points'],
        'total_distance': best_candidate['distance'],
        'points': best_candidate['points'],
        'elevation_gain': best_candidate['elevation_gain'],
        'note': f"自動ルート生成が完了。総上昇量: {round(best_candidate['elevation_gain'])}m"
    })

if __name__ == '__main__':
    # スマホのGPS取得に必須のため ssl_context='adhoc' を利用
    app.run(host='0.0.0.0', port=5000, debug=True, ssl_context='adhoc')
