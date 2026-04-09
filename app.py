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

def generate_loop_waypoints(start, end, D, L):
    """
    同じ道を2度通らないように、迂回または周回するための経由地を生成する。
    """
    waypoints = []
    
    # 希望距離が小さすぎる場合の補正
    if L < D * 1.1:
        L = D * 1.1
    if L < 0.5:
        L = 0.5
        
    # スタートとゴールが同じ、または非常に近い場合（完全な周回コース）
    if D < 0.1:
        # 円周Lの円形のルートを生成 (半径 R_km = L / 2π)
        R_km = L / (2 * math.pi)
        R_deg = R_km / 111.0 # 約111kmで1度
        
        # スタート地点からランダムな方向(center_angle)に円の中心を取る
        center_angle = random.uniform(0, 2 * math.pi)
        lat_rad = math.radians(start['lat'])
        center_lat = start['lat'] + R_deg * math.sin(center_angle)
        center_lng = start['lng'] + (R_deg * math.cos(center_angle)) / math.cos(lat_rad)
        
        # 中心から見て、スタート地点とは反対側の3ヶ所（90度、180度、270度）を経由地とする
        start_angle_rel = center_angle + math.pi
        
        for i in [1, 2, 3]:
            w_angle = start_angle_rel + (i * math.pi / 2.0)
            fuzz_R = random.uniform(0.8, 1.2) * R_deg # 少しだけ形を崩してランダム性を出す
            w_lat = center_lat + fuzz_R * math.sin(w_angle)
            w_lng = center_lng + (fuzz_R * math.cos(w_angle)) / math.cos(lat_rad)
            waypoints.append({'lat': w_lat, 'lng': w_lng})
            
    else:
        # スタートとゴールが離れている場合（大きな迂回ループ）
        # 膨らみを計算 (H = sqrt(L^2 - D^2) / 2)
        H_km = math.sqrt(max(0, L**2 - D**2)) / 2.0
        H_deg = H_km / 111.0
        
        mid_lat = (start['lat'] + end['lat']) / 2.0
        # ２点間の方向ベクトルと垂直ベクトル
        dlat = end['lat'] - start['lat']
        dlng = end['lng'] - start['lng']
        length = math.hypot(-dlng, dlat) or 1
        
        perp_lat = -dlng / length
        perp_lng = dlat / length
        
        side = random.choice([-1, 1])
        lat_rad = math.radians(mid_lat)
        
        # 行って戻って同じ道にならないように、2つの経由地を配置して四角形のような軌道を作る
        for i in [1, 2]:
            base_lat = start['lat'] + dlat * (i / 3.0)
            base_lng = start['lng'] + dlng * (i / 3.0)
            
            fuzz_H = random.uniform(0.7, 1.3) * H_deg # 高さにも少し揺らぎ
            w_lat = base_lat + perp_lat * fuzz_H * side
            w_lng = base_lng + (perp_lng * fuzz_H * side) / math.cos(lat_rad)
            waypoints.append({'lat': w_lat, 'lng': w_lng})
            
    return waypoints

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
        
        # 希望距離(L)に応じて、同じ道を通らないように迂回経由地を生成
        extra_waypoints = generate_loop_waypoints(start, end, D, desired_distance)
        
        # 生成した経由地をエンドポイントの直前に挿入
        for wp in extra_waypoints:
            modified_points.insert(-1, wp)
        
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
