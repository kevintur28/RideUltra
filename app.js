const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const OSRM = 'https://router.project-osrm.org';

const mapEl = document.getElementById('map');
const originModeEl = document.getElementById('originMode');
const originInputEl = document.getElementById('originInput');
const destEl = document.getElementById('dest');
const vehicleTypeEl = document.getElementById('vehicleType');
const btnRequest = document.getElementById('btnRequest');
const btnCancel = document.getElementById('btnCancel');
const btnCenter = document.getElementById('btnCenter');

const driverCard = document.getElementById('driverCard');
const driverAvatar = document.getElementById('driverAvatar');
const driverNameEl = document.getElementById('driverName');
const driverRatingEl = document.getElementById('driverRating');
const driverDistanceEl = document.getElementById('driverDistance');
const licensePlateEl = document.getElementById('licensePlate');
const statusLine = document.getElementById('statusLine');
const etaLine = document.getElementById('etaLine');
const distanceLine = document.getElementById('distanceLine');
const fareLine = document.getElementById('fareLine');

let map, userMarker=null, destMarker=null, driverMarker=null;
let driverRouteLayer=null, tripRouteLayer=null;
let currentAnimationHandle=null;
let appState={busy:false, driver:null};

function rnd(min,max){ return Math.random()*(max-min)+min; }
function genPlate(){ const L="ABCDEFGHIJKLMNOPQRSTUVWXYZ"; return L[Math.floor(rnd(0,26))]+L[Math.floor(rnd(0,26))]+L[Math.floor(rnd(0,26))]+'-'+Math.floor(rnd(100,999)); }
function setStatus(txt){ statusLine.textContent=txt; }
function setETA(txt){ etaLine.textContent=txt; }
function setDistance(txt){ distanceLine.textContent=txt; }
function setFare(txt){ fareLine.textContent=txt; }
function formatMeters(m){ if(!isFinite(m)) return ''; return m>=1000?(m/1000).toFixed(1)+' km':Math.round(m)+' m'; }
function haversineMeters(lat1,lon1,lat2,lon2){ const R=6371000; const toRad=v=>v*Math.PI/180; const dLat=toRad(lat2-lat1); const dLon=toRad(lon2-lon1); const a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2; return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a)); }
function emojiIcon(e){ return L.divIcon({ html:`<div style="font-size:34px;line-height:34px">${e}</div>`, className:'', iconSize:[34,34], iconAnchor:[17,17]}); }

async function geocode(q){ 
  const res = await fetch(`${NOMINATIM}?format=json&limit=1&q=${encodeURIComponent(q)}`, {headers:{'Accept':'application/json'}});
  const j = await res.json();
  if(!j || !j.length) return null;
  return { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon), name: j[0].display_name };
}

async function osrmRoute(a,b){
  const coords=`${a.lng},${a.lat};${b.lng},${b.lat}`;
  const res = await fetch(`${OSRM}/route/v1/driving/${coords}?overview=full&geometries=geojson&annotations=duration,distance`);
  const j = await res.json();
  if(!j?.routes?.length) return null;
  const r=j.routes[0];
  return { points: r.geometry.coordinates.map(c=>[c[1],c[0]]), distance: r.distance, duration: r.duration };
}

function clearAnimation(){ if(currentAnimationHandle){ cancelAnimationFrame(currentAnimationHandle); currentAnimationHandle=null; } }
function removeIfLayer(l){ if(!l) return; try{ map.removeLayer(l); }catch(e){} }

function smoothAnimateAlong(marker, points, totalSeconds, onProgress, onComplete){
  if(!points?.length){ onComplete(); return; }
  let start=null;
  const total=points.length;
  function step(ts){
    if(!start) start=ts;
    const t=Math.min(1,(ts-start)/1000/totalSeconds);
    const idx=Math.floor(t*(total-1));
    marker.setLatLng(points[idx]);
    if(onProgress) onProgress(points[idx],idx,total);
    if(t>=1){ onComplete(); return; }
    currentAnimationHandle=requestAnimationFrame(step);
  }
  currentAnimationHandle=requestAnimationFrame(step);
}

async function initMap(){
  map=L.map('map',{zoomControl:true}).setView([4.60971,-74.08175],13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map);
  try{
    const pos = await new Promise((res,rej)=>navigator.geolocation.getCurrentPosition(res,rej,{enableHighAccuracy:true,timeout:8000}));
    const u={lat:pos.coords.latitude,lng:pos.coords.longitude};
    userMarker=L.marker([u.lat,u.lng]).addTo(map).bindPopup('Tú').openPopup();
    map.setView([u.lat,u.lng],15);
    setStatus('Ubicación detectada');
  }catch(e){
    userMarker=L.marker([4.60971,-74.08175]).addTo(map).bindPopup('Bogotá (fallback)').openPopup();
    map.setView([4.60971,-74.08175],13);
    setStatus('Ubicación no disponible — usando Bogotá');
  }
}

originModeEl.addEventListener('change',()=>{ originModeEl.value==='manual'?originInputEl.style.display='block':originInputEl.style.display='none'; });
btnCenter.addEventListener('click',()=>{ if(userMarker) map.setView(userMarker.getLatLng(),15); });
btnCancel.addEventListener('click',()=>{
  if(appState.busy && currentAnimationHandle) clearAnimation();
  appState.busy=false;
  btnRequest.disabled=false;
  btnCancel.disabled=true;
  setStatus('Solicitud cancelada');
  removeIfLayer(driverMarker); removeIfLayer(destMarker);
  removeIfLayer(driverRouteLayer); removeIfLayer(tripRouteLayer);
  driverCard.setAttribute('aria-hidden','true');
  setETA(''); setDistance(''); setFare('');
});

btnRequest.addEventListener('click', async ()=>{
  if(appState.busy) return;
  appState.busy=true;
  btnRequest.disabled=true;
  btnCancel.disabled=false;
  setStatus('Validando datos...');
  try{
    let origin;
    if(originModeEl.value==='gps'){
      const pos = await new Promise((res,rej)=>navigator.geolocation.getCurrentPosition(res,rej,{enableHighAccuracy:true,timeout:8000}));
      origin={lat:pos.coords.latitude,lng:pos.coords.longitude};
      userMarker ? userMarker.setLatLng([origin.lat,origin.lng]) : userMarker=L.marker([origin.lat,origin.lng]).addTo(map);
    }else{
      const q=originInputEl.value?.trim();
      if(!q) throw new Error('Escribe la dirección de origen.');
      setStatus('Geocodificando origen...');
      const og=await geocode(q+', Bogotá');
      if(!og) throw new Error('Origen no encontrado.');
      origin={lat:og.lat,lng:og.lng};
      userMarker ? userMarker.setLatLng([origin.lat,origin.lng]) : userMarker=L.marker([origin.lat,origin.lng]).addTo(map);
    }

    const destQ=destEl.value?.trim();
    if(!destQ) throw new Error('Escribe la dirección de destino.');
    setStatus('Geocodificando destino...');
    const destination=await geocode(destQ+', Bogotá');
    if(!destination) throw new Error('Destino no encontrado.');
    removeIfLayer(destMarker);
    destMarker=L.marker([destination.lat,destination.lng]).addTo(map).bindPopup(destination.name||destQ).openPopup();

    setStatus('Buscando conductor...');
    const vehicleEmoji=vehicleTypeEl.value==='moto'?'🏍️':'🚗';
    const driverStart={lat:origin.lat+rnd(0.005,0.02)*(Math.random()<0.5?-1:1),lng:origin.lng+rnd(0.005,0.02)*(Math.random()<0.5?-1:1)};
    removeIfLayer(driverMarker);
    driverMarker=L.marker([driverStart.lat,driverStart.lng],{icon:emojiIcon(vehicleEmoji)}).addTo(map);

    const driver={id:Math.floor(rnd(1000,9999)),name:['Carlos','Ana','Luis','Sofía','Diego','Valeria','Mateo','Lucía'][Math.floor(rnd(0,8))],rating:(4.4+rnd(0,0.6)).toFixed(1),plate:genPlate(),vehicle:vehicleTypeEl.value};
    appState.driver=driver;
    driverAvatar.innerHTML=`<div style="font-size:50px">${vehicleEmoji}</div>`;
    driverNameEl.textContent=driver.name;
    driverRatingEl.textContent=`${driver.rating} ★`;
    driverDistanceEl.textContent='';
    licensePlateEl.textContent=`Placa: ${driver.plate}`;
    driverCard.setAttribute('aria-hidden','false');

    setStatus('Calculando rutas...');
    const routeDriverToOrigin=await osrmRoute({lat:driverStart.lat,lng:driverStart.lng}, origin);
    if(!routeDriverToOrigin) throw new Error('Ruta conductor→origen fallida');
    removeIfLayer(driverRouteLayer);
    driverRouteLayer=L.polyline(routeDriverToOrigin.points,{color:'#ff1f1f',weight:4,dashArray:'5,5'}).addTo(map);

    const routeOriginToDest=await osrmRoute(origin,destination);
    if(!routeOriginToDest) throw new Error('Ruta origen→destino fallida');
    removeIfLayer(tripRouteLayer);
    tripRouteLayer=L.polyline(routeOriginToDest.points,{color:'#0b62d1',weight:4}).addTo(map);

    const driverDurationSec=routeDriverToOrigin.duration;
    const tripDurationSec=routeOriginToDest.duration;

    const driverETAmin = Math.max(1, Math.round(driverDurationSec/60));
    const tripETAmin = Math.max(1, Math.round(tripDurationSec/60));
    setETA(`Tiempo estimado de llegada: ${driverETAmin} min • Tiempo estimado de viaje: ${tripETAmin} min`);
    setDistance(`Conductor: ${(routeDriverToOrigin.distance/1000).toFixed(2)} km • Viaje: ${(routeOriginToDest.distance/1000).toFixed(2)} km`);
    setFare(`COP ${Math.round(routeOriginToDest.distance/1000*1100 + tripDurationSec/60*200+3000).toLocaleString()}`);

    clearAnimation();
    smoothAnimateAlong(driverMarker, routeDriverToOrigin.points, driverDurationSec, (pos,idx,total)=>{
      const remaining=haversineMeters(pos[0],pos[1],routeDriverToOrigin.points[total-1][0],routeDriverToOrigin.points[total-1][1]);
      driverDistanceEl.textContent=`Distancia hasta origen: ${formatMeters(remaining)}`;
    }, async ()=>{
      setStatus('Conductor llegó al origen — abordaje');
      driverDistanceEl.textContent='Conductor llegó';
      await new Promise(r=>setTimeout(r,900));
      clearAnimation();
      smoothAnimateAlong(driverMarker, routeOriginToDest.points, tripDurationSec, (pos,idx,total)=>{
        const remainingMeters=haversineMeters(pos[0],pos[1],destination.lat,destination.lng);
        setDistance(`Distancia restante: ${formatMeters(remainingMeters)}`);
        const remainingMin = Math.max(1, Math.round((remainingMeters/Math.max(100,routeOriginToDest.distance)*tripDurationSec)/60));
        setETA(`Tiempo estimado de llegada: ${remainingMin} min`);
      }, ()=>{
        setStatus('Llegaste al destino ✅');
        setETA(''); setDistance('');
        btnRequest.disabled=false; btnCancel.disabled=true; appState.busy=false;
      });
    });

  }catch(err){
    alert('Error: '+err.message); setStatus('Error: '+err.message);
    btnRequest.disabled=false; btnCancel.disabled=true; appState.busy=false;
  }
});

initMap();
