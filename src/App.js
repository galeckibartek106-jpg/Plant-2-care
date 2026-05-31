import { useState, useEffect, useRef } from "react";

// ─── helpers ────────────────────────────────────────────────────────────────
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (dateStr, n) => {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
const diffDays = (a, b) => {
  const msA = new Date(a), msB = new Date(b);
  return Math.round((msA - msB) / 86400000);
};
const isInDormancy = (dormancy, globalDormancy) => {
  const effective = (dormancy.useGlobal !== false && globalDormancy) ? globalDormancy : dormancy;
  if (!effective || !effective.enabled) return false;
  const now = new Date();
  const m = now.getMonth() + 1; const d = now.getDate();
  const cur = m * 100 + d;
  const start = effective.startMonth * 100 + effective.startDay;
  const end = effective.endMonth * 100 + effective.endDay;
  if (start <= end) return cur >= start && cur <= end;
  return cur >= start || cur <= end;
};
const uid = () => Math.random().toString(36).slice(2, 9);
const STORAGE_KEY = "plantcare_v2";
const MONTH_NAMES = ["Sty","Lut","Mar","Kwi","Maj","Cze","Lip","Sie","Wrz","Paź","Lis","Gru"];

// ─── Google Drive config ─────────────────────────────────────────────
const GD_CLIENT_ID = "630282425782-gnh4mk3drpgbj0mhmjpd5eqncpeeo4mi.apps.googleusercontent.com";
const GD_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const GD_FILENAME = "plant-care-backup.json";
const GD_FOLDER = "appDataFolder";

// Load GIS + GAPI scripts dynamically
const loadScript = (src) => new Promise((res,rej)=>{
  if(document.querySelector(`script[src="${src}"]`)){res();return;}
  const s=document.createElement("script"); s.src=src; s.onload=res; s.onerror=rej;
  document.head.appendChild(s);
});

let _gapiReady = false;
let _tokenClient = null;
let _accessToken = null;

async function initGoogleDrive() {
  await loadScript("https://apis.google.com/js/api.js");
  await loadScript("https://accounts.google.com/gsi/client");
  await new Promise(res => window.gapi.load("client", res));
  await window.gapi.client.init({});
  await window.gapi.client.load("https://www.googleapis.com/discovery/v1/apis/drive/v3/rest");
  _gapiReady = true;
  _tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: GD_CLIENT_ID,
    scope: GD_SCOPE,
    callback: () => {},
  });
}

function getToken() {
  return new Promise((res, rej) => {
    _tokenClient.callback = (resp) => {
      if(resp.error){ rej(resp); return; }
      _accessToken = resp.access_token;
      res(resp.access_token);
    };
    if(_accessToken) { res(_accessToken); return; }
    _tokenClient.requestAccessToken({ prompt: "consent" });
  });
}

async function gdSave(data) {
  const token = await getToken();
  // find existing file
  const list = await window.gapi.client.drive.files.list({
    spaces: GD_FOLDER, q: `name='${GD_FILENAME}'`, fields:"files(id)"
  });
  const files = list.result.files;
  const body = JSON.stringify(data, null, 2);
  const metadata = { name: GD_FILENAME, parents: files.length ? undefined : [GD_FOLDER] };

  if(files.length) {
    // update existing
    await fetch(`https://www.googleapis.com/upload/drive/v3/files/${files[0].id}?uploadType=multipart`, {
      method:"PATCH",
      headers:{ Authorization:`Bearer ${token}` },
      body: (() => {
        const fd = new FormData();
        fd.append("metadata", new Blob([JSON.stringify({name:GD_FILENAME})],{type:"application/json"}));
        fd.append("file", new Blob([body],{type:"application/json"}));
        return fd;
      })(),
    });
  } else {
    // create new
    await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
      method:"POST",
      headers:{ Authorization:`Bearer ${token}` },
      body: (() => {
        const fd = new FormData();
        fd.append("metadata", new Blob([JSON.stringify({name:GD_FILENAME,parents:[GD_FOLDER]})],{type:"application/json"}));
        fd.append("file", new Blob([body],{type:"application/json"}));
        return fd;
      })(),
    });
  }
}

async function gdLoad() {
  const token = await getToken();
  const list = await window.gapi.client.drive.files.list({
    spaces: GD_FOLDER, q: `name='${GD_FILENAME}'`, fields:"files(id)"
  });
  const files = list.result.files;
  if(!files.length) throw new Error("Brak kopii na Google Drive.");
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${files[0].id}?alt=media`, {
    headers:{ Authorization:`Bearer ${token}` }
  });
  return await resp.json();
}

const CARE_TYPES = [
  { key: "watering",    label: "Podlewanie",  icon: "💧", color: "#4fc3f7" },
  { key: "fertilizing", label: "Nawożenie",   icon: "🌿", color: "#81c784" },
  { key: "repotting",   label: "Przesadzanie",icon: "🪴", color: "#ffb74d" },
];

const DEFAULT_DORMANCY = { enabled:false, startMonth:11, startDay:1, endMonth:2, endDay:28 };
const DEFAULT_CARE = {
  watering:    { freq:7,   dormFreq:14,  lastDone:today(), history:[] },
  fertilizing: { freq:14,  dormFreq:30,  lastDone:today(), history:[] },
  repotting:   { freq:365, dormFreq:365, lastDone:today(), history:[] },
};

const selectStyle = {
  background:"#1e2a1e", border:"1px solid #3a4a3a", color:"#e0ffe0",
  borderRadius:8, padding:"4px 8px", fontSize:13, fontFamily:"inherit",
};

// ─── WateringChart ───────────────────────────────────────────────────────────
function WateringChart({ history }) {
  if (!history || history.length < 2) return (
    <div style={{color:"#3a5a3a",fontSize:13,textAlign:"center",padding:"20px 0",fontStyle:"italic"}}>
      Potrzeba co najmniej 2 podlewań, aby pokazać wykres.
    </div>
  );

  // compute intervals between consecutive waterings
  const sorted = [...history].sort();
  const intervals = [];
  for (let i = 1; i < sorted.length; i++) {
    intervals.push({ date: sorted[i], days: diffDays(sorted[i], sorted[i-1]) });
  }

  const last10 = intervals.slice(-10);
  const avg = Math.round(last10.reduce((s, x) => s + x.days, 0) / last10.length);
  const maxDays = Math.max(...last10.map(x => x.days), 1);

  const barColor = (days) => {
    if (days <= avg * 0.8) return "#4fc3f7";
    if (days <= avg * 1.3) return "#81c784";
    return "#ffb74d";
  };

  return (
    <div>
      {/* avg badge */}
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
        <div style={{
          background:"#4fc3f722",border:"1px solid #4fc3f755",borderRadius:10,
          padding:"6px 14px",display:"inline-flex",alignItems:"center",gap:8,
        }}>
          <span style={{color:"#4fc3f7",fontSize:12,fontFamily:"'Space Mono',monospace"}}>ŚREDNIA (ostatnie {last10.length})</span>
          <span style={{color:"#fff",fontWeight:700,fontSize:20}}>{avg} dni</span>
        </div>
        <span style={{color:"#3a5a3a",fontSize:12}}>{intervals.length} podlewań łącznie</span>
      </div>

      {/* bar chart */}
      <div style={{display:"flex",alignItems:"flex-end",gap:5,height:90,marginBottom:6}}>
        {/* avg line reference */}
        <div style={{position:"relative",display:"flex",alignItems:"flex-end",gap:5,width:"100%",height:"100%"}}>
          {/* avg dashed line */}
          <div style={{
            position:"absolute",bottom:`${(avg/maxDays)*100}%`,
            left:0,right:0,borderTop:"1px dashed #4fc3f766",
            pointerEvents:"none",zIndex:1,
          }}>
            <span style={{
              position:"absolute",right:0,top:-16,
              fontSize:10,color:"#4fc3f7",fontFamily:"'Space Mono',monospace",
              background:"#0d150d",padding:"0 3px",
            }}>⌀{avg}d</span>
          </div>
          {last10.map((item, i) => {
            const h = Math.max(4, Math.round((item.days / maxDays) * 100));
            const col = barColor(item.days);
            const dateShort = item.date.slice(5).replace("-",".");
            return (
              <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",height:"100%",justifyContent:"flex-end",position:"relative",zIndex:2}}>
                <div title={`${item.days} dni · ${item.date}`} style={{
                  width:"100%", height:`${h}%`,
                  background: col, borderRadius:"4px 4px 0 0",
                  minHeight:4, cursor:"default",
                  boxShadow:`0 0 6px ${col}55`,
                  transition:"height .4s ease",
                }}/>
              </div>
            );
          })}
        </div>
      </div>

      {/* x-axis labels */}
      <div style={{display:"flex",gap:5}}>
        {last10.map((item,i) => {
          const dateShort = item.date.slice(5).replace("-",".");
          return (
            <div key={i} style={{flex:1,textAlign:"center",fontSize:9,color:"#556655",fontFamily:"'Space Mono',monospace",lineHeight:1.2}}>
              {dateShort}<br/>
              <span style={{color: barColor(item.days),fontWeight:700}}>{item.days}d</span>
            </div>
          );
        })}
      </div>

      {/* legend */}
      <div style={{display:"flex",gap:12,marginTop:10,flexWrap:"wrap"}}>
        {[["#4fc3f7","Krótko (< avg×0.8)"],["#81c784","Normalnie"],["#ffb74d","Długo (> avg×1.3)"]].map(([c,l])=>(
          <div key={l} style={{display:"flex",alignItems:"center",gap:4,fontSize:10,color:"#668866"}}>
            <div style={{width:10,height:10,borderRadius:2,background:c}}/>
            {l}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── CareHistory ─────────────────────────────────────────────────────────────
function CareHistory({ plant, onSave }) {
  const [activeTab, setActiveTab] = useState("watering");
  const ct = CARE_TYPES.find(x => x.key === activeTab);
  const care = plant.care[activeTab];
  const history = care.history || [];
  const sorted = [...history].sort().reverse(); // newest first

  const removeEntry = (date) => {
    const updated = JSON.parse(JSON.stringify(plant));
    updated.care[activeTab].history = updated.care[activeTab].history.filter(d => d !== date);
    // if removed entry was lastDone, update lastDone
    if (updated.care[activeTab].lastDone === date) {
      const remaining = [...updated.care[activeTab].history].sort();
      updated.care[activeTab].lastDone = remaining.length ? remaining[remaining.length-1] : today();
    }
    onSave(updated);
  };

  return (
    <div>
      {/* tab bar */}
      <div style={{display:"flex",gap:6,marginBottom:14}}>
        {CARE_TYPES.map(t => (
          <button key={t.key} onClick={()=>setActiveTab(t.key)} style={{
            flex:1,padding:"6px 0",borderRadius:8,fontSize:12,cursor:"pointer",fontFamily:"inherit",
            background: activeTab===t.key ? t.color+"22" : "#ffffff08",
            border: activeTab===t.key ? `1px solid ${t.color}55` : "1px solid #ffffff10",
            color: activeTab===t.key ? t.color : "#668866",
            fontWeight: activeTab===t.key ? 700 : 400,
          }}>{t.icon} {t.label}</button>
        ))}
      </div>

      {/* watering chart */}
      {activeTab === "watering" && (
        <div style={{marginBottom:16,padding:"14px",background:"#ffffff06",borderRadius:12,border:"1px solid #ffffff10"}}>
          <div style={{color:"#668866",fontSize:11,fontFamily:"'Space Mono',monospace",marginBottom:10,letterSpacing:1}}>
            CZĘSTOTLIWOŚĆ PODLEWANIA
          </div>
          <WateringChart history={history}/>
        </div>
      )}

      {/* history log */}
      <div style={{color:"#668866",fontSize:11,fontFamily:"'Space Mono',monospace",marginBottom:8,letterSpacing:1}}>
        HISTORIA ({sorted.length} wpisów)
      </div>
      {sorted.length === 0 ? (
        <div style={{color:"#3a5a3a",fontSize:13,fontStyle:"italic",padding:"10px 0"}}>
          Brak historii. Użyj przycisku ✓ przy pielęgnacji.
        </div>
      ) : (
        <div style={{display:"flex",flexDirection:"column",gap:4,maxHeight:200,overflowY:"auto",paddingRight:4}}>
          {sorted.map((date,i) => {
            const isLatest = i === 0;
            const prevDate = sorted[i+1];
            const interval = prevDate ? diffDays(date, prevDate) : null;
            return (
              <div key={date} style={{
                display:"flex",alignItems:"center",gap:8,
                padding:"7px 10px",borderRadius:8,
                background: isLatest ? ct.color+"12" : "#ffffff06",
                border: `1px solid ${isLatest ? ct.color+"33" : "#ffffff08"}`,
              }}>
                <span style={{fontSize:13}}>{ct.icon}</span>
                <span style={{flex:1,fontSize:13,color:"#c0e0c0"}}>
                  {new Date(date).toLocaleDateString("pl-PL",{day:"numeric",month:"short",year:"numeric"})}
                  {isLatest && <span style={{marginLeft:6,fontSize:10,color:ct.color,fontWeight:700}}>ostatnie</span>}
                </span>
                {interval !== null && (
                  <span style={{fontSize:11,color:"#556655",fontFamily:"'Space Mono',monospace"}}>
                    +{interval}d
                  </span>
                )}
                <button onClick={()=>removeEntry(date)} style={{
                  background:"none",border:"none",color:"#3a4a3a",cursor:"pointer",
                  fontSize:14,padding:"0 2px",lineHeight:1,
                }} title="Usuń wpis">×</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Badge ───────────────────────────────────────────────────────────────────
function Badge({ text, color, onRemove }) {
  return (
    <span style={{
      display:"inline-flex",alignItems:"center",gap:4,
      background:color+"22", border:`1px solid ${color}55`,
      color, borderRadius:20, padding:"2px 10px", fontSize:12, fontFamily:"inherit",
    }}>
      {text}
      {onRemove && <button onClick={onRemove} style={{background:"none",border:"none",color,cursor:"pointer",padding:0,lineHeight:1,fontSize:13}}>×</button>}
    </span>
  );
}

// ─── DormancyPicker ──────────────────────────────────────────────────────────
function DormancyPicker({ value, onChange, globalDormancy, isPlantLevel }) {
  const months = MONTH_NAMES.map((m,i) => <option key={i+1} value={i+1}>{m}</option>);
  const days = Array.from({length:31},(_,i) => <option key={i+1} value={i+1}>{i+1}</option>);
  const useGlobal = value.useGlobal !== false && isPlantLevel;
  const effective = (useGlobal && globalDormancy) ? globalDormancy : value;
  const formatPeriod = (d) => {
    if (!d || !d.enabled) return "wyłączone";
    return `${d.startDay} ${MONTH_NAMES[d.startMonth-1]} – ${d.endDay} ${MONTH_NAMES[d.endMonth-1]}`;
  };
  return (
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      {isPlantLevel && (
        <div style={{display:"flex",gap:8,marginBottom:2}}>
          {[{v:true,l:"🌍 Globalny"},{v:false,l:"✏️ Własny"}].map(opt=>(
            <button key={String(opt.v)} onClick={()=>onChange({...value,useGlobal:opt.v})} style={{
              flex:1,padding:"7px 0",borderRadius:9,fontSize:13,cursor:"pointer",fontFamily:"inherit",
              background:useGlobal===opt.v?"#81c78422":"#ffffff08",
              border:useGlobal===opt.v?"1px solid #81c78466":"1px solid #ffffff15",
              color:useGlobal===opt.v?"#81c784":"#888",
              fontWeight:useGlobal===opt.v?600:400,
            }}>{opt.l}</button>
          ))}
        </div>
      )}
      {useGlobal && isPlantLevel ? (
        <div style={{padding:"10px 14px",borderRadius:10,background:"#ffffff08",border:"1px solid #ffffff15",color:"#aaa",fontSize:13}}>
          {globalDormancy?.enabled
            ? <>❄️ Zima: <strong style={{color:"#90caf9"}}>{formatPeriod(globalDormancy)}</strong></>
            : <span style={{color:"#556655"}}>Tryb uśpienia globalnie wyłączony</span>}
        </div>
      ) : (
        <>
          <label style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer"}}>
            <input type="checkbox" checked={effective.enabled}
              onChange={e=>onChange({...value,useGlobal:false,enabled:e.target.checked})}
              style={{accentColor:"#81c784",width:16,height:16}}/>
            <span style={{color:"#ccc",fontSize:14}}>Włącz tryb uśpienia (zima)</span>
          </label>
          {effective.enabled && (
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,padding:"12px",background:"#ffffff08",borderRadius:10,border:"1px solid #ffffff15"}}>
              <div>
                <div style={{color:"#aaa",fontSize:12,marginBottom:4}}>Początek</div>
                <div style={{display:"flex",gap:6}}>
                  <select value={effective.startDay} onChange={e=>onChange({...value,useGlobal:false,startDay:+e.target.value})} style={selectStyle}>{days}</select>
                  <select value={effective.startMonth} onChange={e=>onChange({...value,useGlobal:false,startMonth:+e.target.value})} style={selectStyle}>{months}</select>
                </div>
              </div>
              <div>
                <div style={{color:"#aaa",fontSize:12,marginBottom:4}}>Koniec</div>
                <div style={{display:"flex",gap:6}}>
                  <select value={effective.endDay} onChange={e=>onChange({...value,useGlobal:false,endDay:+e.target.value})} style={selectStyle}>{days}</select>
                  <select value={effective.endMonth} onChange={e=>onChange({...value,useGlobal:false,endMonth:+e.target.value})} style={selectStyle}>{months}</select>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── CareRow ─────────────────────────────────────────────────────────────────
function CareRow({ ct, care, dormancy, onChange, globalDormancy, onDone }) {
  const inDorm = isInDormancy(dormancy, globalDormancy);
  const activeFreq = inDorm ? care.dormFreq : care.freq;
  const nextDate = addDays(care.lastDone, activeFreq);
  const diff = diffDays(nextDate, today());
  const urgent = diff <= 0;
  const soon = diff <= 2 && diff > 0;
  return (
    <div style={{padding:"10px 14px",borderRadius:10,background:urgent?ct.color+"18":"#ffffff06",border:`1px solid ${urgent?ct.color+"55":"#ffffff10"}`}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:18}}>{ct.icon}</span>
          <div>
            <div style={{color:"#e0ffe0",fontSize:13,fontWeight:600}}>{ct.label}</div>
            <div style={{color:"#888",fontSize:11}}>
              {inDorm?`Zimowe: co ${care.dormFreq} dni`:`Co ${care.freq} dni`}
              {dormancy.enabled && <span style={{color:"#81c784",marginLeft:6}}>{inDorm?"❄️":"☀️"}</span>}
            </div>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:12,fontWeight:700,color:urgent?ct.color:soon?"#ffb74d":"#888"}}>
            {urgent?`Zaległe ${Math.abs(diff)} dni`:diff===0?"Dziś!":`Za ${diff} dni`}
          </span>
          <button onClick={onDone} style={{background:ct.color+"22",border:`1px solid ${ct.color}55`,color:ct.color,borderRadius:8,padding:"4px 10px",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>
            ✓ Zrobione
          </button>
        </div>
      </div>
      <div style={{display:"flex",gap:16,marginTop:10,flexWrap:"wrap"}}>
        <label style={{display:"flex",alignItems:"center",gap:6,color:"#aaa",fontSize:12}}>
          Aktywna: co
          <input type="number" min={1} value={care.freq} onChange={e=>onChange({...care,freq:+e.target.value})} style={{...selectStyle,width:52,textAlign:"center"}}/>
          dni
        </label>
        {dormancy.enabled && (
          <label style={{display:"flex",alignItems:"center",gap:6,color:"#aaa",fontSize:12}}>
            Zimowa: co
            <input type="number" min={1} value={care.dormFreq} onChange={e=>onChange({...care
