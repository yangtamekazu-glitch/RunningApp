let map;
let markers = [];
let routePolyline = null;
let lastGeneratedPoints = [];
let addingWaypointMode = false;
let pendingWaypoints = [];
let pendingWaypointMarkers = [];
let savedLocations = [];

// ローカルストレージからブックマークを読み込み
try {
    const data = localStorage.getItem('runningApp_bookmarks');
    if (data) savedLocations = JSON.parse(data);
} catch (e) { console.error(e); }


function initMap() {
    // デフォルトの中心位置（東京駅周辺）
    map = new google.maps.Map(document.getElementById("map"), {
        center: { lat: 35.6812, lng: 139.7671 },
        zoom: 13,
        disableDefaultUI: true,
        zoomControl: true,
    });

    // URLパラメータから連携された経由地を取得
    const urlParams = new URLSearchParams(window.location.search);
    const wLat = parseFloat(urlParams.get('waypoint_lat'));
    const wLng = parseFloat(urlParams.get('waypoint_lng'));
    if (!isNaN(wLat) && !isNaN(wLng)) {
        const latLng = new google.maps.LatLng(wLat, wLng);
        pendingWaypoints.push(latLng);
        
        // 待機中の経由地として半透明などの仮ピンを表示する
        const tmpMarker = new google.maps.Marker({
            position: latLng,
            map: map,
            icon: {
                path: google.maps.SymbolPath.CIRCLE,
                fillColor: "#94a3b8", // 待機中を示すグレーアウト色
                fillOpacity: 1,
                strokeWeight: 2,
                strokeColor: "white",
                scale: 12,
            },
            label: {
                text: "予約",
                color: "white",
                fontSize: "10px",
                fontWeight: "bold"
            }
        });
        pendingWaypointMarkers.push(tmpMarker);

        map.setCenter({ lat: wLat, lng: wLng });
        map.setZoom(15);
    }

    // マップ上のクリックで地点を追加
    map.addListener("click", (e) => {
        if (markers.length < 2) {
            addMarker(e.latLng, markers.length === 0 ? 'start' : 'goal');
            
            // ゴール地点が追加された直後（markers.length === 2）、予約経由地があれば展開
            if (markers.length === 2 && pendingWaypoints.length > 0) {
                // 仮ピンをマップから消す
                pendingWaypointMarkers.forEach(m => m.setMap(null));
                pendingWaypointMarkers = [];

                pendingWaypoints.forEach(latLng => {
                    addMarker(latLng, 'waypoint');
                });
                pendingWaypoints = []; // クリア
            }
        } else if (addingWaypointMode) {
            addMarker(e.latLng, 'waypoint');
            addingWaypointMode = false;
            updateStatus();
        }
    });

    document.getElementById("generate-btn").addEventListener("click", generateRoute);
    document.getElementById("reset-btn").addEventListener("click", resetMap);
    document.getElementById("current-location-btn").addEventListener("click", getCurrentLocation);
    document.getElementById("open-google-maps-btn").addEventListener("click", openGoogleMaps);
    renderBookmarks();

    // 経由地追加モードのトグル
    const addWaypointBtn = document.getElementById("add-waypoint-btn");
    if (addWaypointBtn) {
        addWaypointBtn.addEventListener("click", () => {
            if (markers.length >= 2) {
                addingWaypointMode = true;
                updateStatus();
            }
        });
    }

    // ★ お気に入り（ブックマーク）登録ボタン
    const saveBtn = document.getElementById("save-current-btn");
    if (saveBtn) {
        saveBtn.addEventListener("click", () => {
            let locName = prompt("この地点の名前を入力してください（例: 自宅、職場）");
            if (!locName || locName.trim() === "") return;
            const center = map.getCenter();
            savedLocations.push({
                name: locName.substring(0, 10), // Limit length
                lat: center.lat(),
                lng: center.lng()
            });
            localStorage.setItem('runningApp_bookmarks', JSON.stringify(savedLocations));
            renderBookmarks();
            alert(`「${locName}」を保存しました！`);
        });
    }

    initBottomSheet();
}

function getCurrentLocation() {
    const btn = document.getElementById("current-location-btn");
    if (navigator.geolocation) {
        btn.innerText = "📍 取得中...";
        btn.disabled = true;

        navigator.geolocation.getCurrentPosition(
            (position) => {
                const pos = {
                    lat: position.coords.latitude,
                    lng: position.coords.longitude,
                };

                // 元のマーカーやルートをクリア
                resetMap();

                // マップの表示を現在地に移動してズーム
                map.setCenter(pos);
                map.setZoom(15);

                // 現在地をスタート地点（1点目）として追加
                const googlePos = new google.maps.LatLng(pos.lat, pos.lng);
                addMarker(googlePos, 'start');

                btn.innerText = "📍 現在地からスタート";
                btn.disabled = false;
            },
            (error) => {
                console.error("Geolocation error:", error);

                let errorMsg = "現在地の取得に失敗しました。";
                switch (error.code) {
                    case error.PERMISSION_DENIED:
                        errorMsg = "位置情報の取得が拒否されました。ブラウザの設定等で許可してください。";
                        break;
                    case error.POSITION_UNAVAILABLE:
                        errorMsg = "位置情報が取得できません。";
                        break;
                    case error.TIMEOUT:
                        errorMsg = "位置情報の取得がタイムアウトしました。";
                        break;
                }
                alert(errorMsg);

                btn.innerText = "📍 現在地からスタート";
                btn.disabled = false;
            },
            {
                enableHighAccuracy: true,
                timeout: 10000,
                maximumAge: 0
            }
        );
    } else {
        alert("お使いのブラウザは位置情報 (Geolocation API) をサポートしていません。");
    }
}

function addMarker(latLng, type) {
    if (markers.length >= 7) {
        alert("設定できる経由地は最大5ヶ所までです。（スタート・ゴールを含めて全7点）");
        return;
    }

    const svgMarker = {
        path: google.maps.SymbolPath.CIRCLE,
        fillColor: "#3b82f6",
        fillOpacity: 1,
        strokeWeight: 2,
        strokeColor: "white",
        scale: 12,
    };

    const marker = new google.maps.Marker({
        position: latLng,
        map: map,
        icon: svgMarker,
        draggable: true, // ピンを個別に配置（ドラッグ）可能にする
        label: {
            text: "",
            color: "white",
            fontSize: "12px",
            fontWeight: "bold"
        }
    });

    if (type === 'start' || type === 'goal') {
        markers.push(marker);
    } else {
        // スタートとゴールの間に挿入
        markers.splice(markers.length - 1, 0, marker);
    }

    updateLabels();
    updateStatus();
}

function updateLabels() {
    for (let i = 0; i < markers.length; i++) {
        let isStart = (i === 0);
        let isGoal = (i === markers.length - 1);

        let color = isStart ? "#22c55e" : (isGoal ? "#ef4444" : "#3b82f6");
        let label = isStart ? "S" : (isGoal ? "G" : String(i));
        let title = isStart ? "Start" : (isGoal ? "Goal" : "Point");

        markers[i].setOptions({
            title: title,
            icon: {
                path: google.maps.SymbolPath.CIRCLE,
                fillColor: color,
                fillOpacity: 1,
                strokeWeight: 2,
                strokeColor: "white",
                scale: 12,
            },
            label: {
                text: label,
                color: "white",
                fontSize: "12px",
                fontWeight: "bold"
            }
        });
    }
}

function updateStatus() {
    const statusEl = document.getElementById("status");
    const wpBtn = document.getElementById("add-waypoint-btn");

    if (markers.length === 0) {
        let extraMsg = pendingWaypoints.length > 0 ? ` (+連携経由地 ${pendingWaypoints.length}件待機中)` : "";
        statusEl.innerText = "マップ上でスタート地点をクリックしてください。" + extraMsg;
        if (wpBtn) wpBtn.style.display = "none";
    } else if (markers.length === 1) {
        let extraMsg = pendingWaypoints.length > 0 ? ` (+連携経由地 ${pendingWaypoints.length}件待機中)` : "";
        statusEl.innerText = "次にゴール地点をクリックしてください。" + extraMsg;
        if (wpBtn) wpBtn.style.display = "none";
    } else {
        if (addingWaypointMode) {
            statusEl.innerText = "マップ上をクリックして経由地を配置してください。";
            if (wpBtn) wpBtn.style.display = "none";
        } else {
            statusEl.innerText = `現在 ${markers.length} 点設定済み。`;
            if (wpBtn) {
                if (markers.length < 7) {
                    wpBtn.style.display = "block";
                } else {
                    wpBtn.style.display = "none";
                }
            }
        }
    }
}

function resetMap() {
    markers.forEach(m => m.setMap(null));
    markers = [];
    if (routePolyline) {
        routePolyline.setMap(null);
    }
    lastGeneratedPoints = [];
    addingWaypointMode = false;
    pendingWaypoints = [];
    pendingWaypointMarkers.forEach(m => m.setMap(null));
    pendingWaypointMarkers = [];
    document.getElementById("open-google-maps-btn").style.display = "none";
    const wpBtn = document.getElementById("add-waypoint-btn");
    if (wpBtn) wpBtn.style.display = "none";
    updateStatus();
}

async function generateRoute() {
    if (markers.length < 1) {
        alert("少なくともスタート地点を設定してください。");
        return;
    }

    const distanceInput = document.getElementById("distance").value;
    const btn = document.getElementById("generate-btn");

    // バックエンドへ送信するデータを構築
    const points = markers.map(m => ({
        lat: m.getPosition().lat(),
        lng: m.getPosition().lng()
    }));

    if (points.length === 1) {
        // スタートとゴールを同じにする（周回コース）
        points.push({ lat: points[0].lat, lng: points[0].lng });
    }

    const elevationInput = document.getElementById("elevation");
    const payload = {
        points: points,
        desired_distance: parseFloat(distanceInput),
        elevation_preference: elevationInput ? elevationInput.value : "any"
    };

    btn.innerText = "計算中...";
    btn.disabled = true;

    try {
        const response = await fetch('/api/generate_route', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (data.error) {
            alert("エラー: " + data.error);
        } else if (data.polyline) {
            drawRoute(data.polyline);
            // 距離と状態の更新
            let distText = (data.total_distance / 1000).toFixed(2);
            document.getElementById("status").innerText = `ルート生成完了! 推定距離: ${distText} km`;

            lastGeneratedPoints = data.points || [];
            if (lastGeneratedPoints.length >= 2) {
                document.getElementById("open-google-maps-btn").style.display = "block";
            }

            if (data.note) {
                console.log(data.note); // デバッグ用: 迂回アルゴリズム適用のログ
            }
        }
    } catch (e) {
        console.error(e);
        alert("APIリクエスト中にエラーが発生しました。");
    } finally {
        btn.innerText = "ルートを生成する";
        btn.disabled = false;
    }
}

function drawRoute(encodedString) {
    if (routePolyline) {
        routePolyline.setMap(null);
    }

    // Google Maps APIのgeometryライブラリを利用してポリラインをデコード
    const path = google.maps.geometry.encoding.decodePath(encodedString);

    routePolyline = new google.maps.Polyline({
        path: path,
        geodesic: true,
        strokeColor: "#8b5cf6", // Purple route line
        strokeOpacity: 0.8,
        strokeWeight: 6,
    });

    routePolyline.setMap(map);

    // ルート全体が画面に収まるようマップのズームと中心を調整
    const bounds = new google.maps.LatLngBounds();
    path.forEach(p => bounds.extend(p));
    map.fitBounds(bounds);
}

function openGoogleMaps() {
    if (!lastGeneratedPoints || lastGeneratedPoints.length < 2) return;

    const origin = `${lastGeneratedPoints[0].lat},${lastGeneratedPoints[0].lng}`;
    const destination = `${lastGeneratedPoints[lastGeneratedPoints.length - 1].lat},${lastGeneratedPoints[lastGeneratedPoints.length - 1].lng}`;

    // 経由地（スタートとゴール以外）を連結
    let waypointsParam = "";
    if (lastGeneratedPoints.length > 2) {
        const waypoints = lastGeneratedPoints.slice(1, -1)
            .map(p => `${p.lat},${p.lng}`)
            .join('|');
        waypointsParam = `&waypoints=${waypoints}`;
    }

    // Google Maps URLの構築
    const url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}${waypointsParam}&travelmode=walking`;

    window.open(url, '_blank');
}

function initBottomSheet() {
    const panel = document.getElementById('ui-panel');
    const handle = document.getElementById('panel-handle');
    let isDragging = false;
    let startY = 0;
    let startTranslateY = 0;
    let currentTranslateY = 0;

    function getMaxTranslateY() {
        return panel.offsetHeight - 30; // Handle height
    }

    handle.addEventListener('pointerdown', (e) => {
        isDragging = true;
        startY = e.clientY;
        startTranslateY = currentTranslateY;
        panel.style.transition = 'none';
        handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener('pointermove', (e) => {
        if (!isDragging) return;
        const deltaY = e.clientY - startY;
        currentTranslateY = startTranslateY + deltaY;

        const max = getMaxTranslateY();
        if (currentTranslateY < 0) currentTranslateY = 0;
        if (currentTranslateY > max) currentTranslateY = max;

        panel.style.transform = `translateY(${currentTranslateY}px)`;
    });

    handle.addEventListener('pointerup', (e) => {
        if (!isDragging) return;
        isDragging = false;
        panel.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
        handle.releasePointerCapture(e.pointerId);

        const deltaY = e.clientY - startY;
        const max = getMaxTranslateY();

        if (Math.abs(deltaY) < 5) {
            if (currentTranslateY > max / 2) {
                currentTranslateY = 0;
            } else {
                currentTranslateY = max;
            }
            panel.style.transform = `translateY(${currentTranslateY}px)`;
        }
    });

    window.addEventListener('resize', () => {
        const max = getMaxTranslateY();
        if (currentTranslateY > max) {
            currentTranslateY = max;
        }
        panel.style.transition = 'none';
        panel.style.transform = `translateY(${currentTranslateY}px)`;
    });
}

// お気に入り地点をUIに表示する関数
function renderBookmarks() {
    const listEl = document.getElementById("saved-locations-list");
    if (!listEl) return;
    listEl.innerHTML = "";
    
    if (savedLocations.length === 0) {
        listEl.innerHTML = `<span style="color:#666; font-size:0.85rem;">まだ登録されていません。</span>`;
        return;
    }

    savedLocations.forEach((loc, index) => {
        const btn = document.createElement("button");
        btn.className = "secondary";
        btn.style.padding = "4px 8px";
        btn.style.fontSize = "0.85rem";
        btn.style.marginRight = "4px";
        btn.textContent = `📍 ${loc.name}`;
        btn.title = "クリックでこの場所をセット";
        
        btn.addEventListener("click", () => {
            const latLng = new google.maps.LatLng(loc.lat, loc.lng);
            
            if (markers.length < 2) {
                addMarker(latLng, markers.length === 0 ? "start" : "goal");
                
                if (markers.length === 2 && pendingWaypoints.length > 0) {
                    pendingWaypointMarkers.forEach(m => m.setMap(null));
                    pendingWaypointMarkers = [];
                    pendingWaypoints.forEach(ll => addMarker(ll, "waypoint"));
                    pendingWaypoints = [];
                }
            } else if (addingWaypointMode) {
                addMarker(latLng, "waypoint");
                addingWaypointMode = false;
                updateStatus();
            } else {
                alert("すでにスタートとゴールが設定されています。「経由地を追加」を押してから使ってみてください！");
            }
            
            map.setCenter(latLng);
        });

        listEl.appendChild(btn);
    });
}

