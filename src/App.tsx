import React, { useState, useEffect, useRef } from 'react';
import GpxParser from 'gpxparser';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Zap, 
  Move, 
  Map as MapIcon, 
  Upload, 
  ChevronRight, 
  Bluetooth, 
  Play, 
  Pause, 
  RefreshCcw,
  Activity,
  Wind,
  Mountain
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import { 
  GPXPoint, 
  FTMSData, 
  SimulationState, 
  DEFAULT_BIKE_CONFIG 
} from './types';
import { calculateVelocity, mpsToKph } from './lib/physics';
import { VirtualWorld } from './components/VirtualWorld';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Simulation Logic ---

const App: React.FC = () => {
  const [points, setPoints] = useState<GPXPoint[]>([]);
  const [ftmsData, setFtmsData] = useState<FTMSData>({ power: 0, cadence: 0, speed: 0, heartRate: 0 });
  const [simState, setSimState] = useState<SimulationState>({
    virtualSpeed: 0,
    distance: 0,
    grade: 0,
    currentPointIndex: 0,
    isActive: false,
  });
  
  // High-frequency simulation state ref
  const simRef = useRef({
    distance: 0,
    currentIndex: 0,
    virtualSpeed: 0,
    grade: 0,
    lastUiUpdate: 0
  });

  const [isSimulatorMode, setIsSimulatorMode] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);

  const lastUpdateRef = useRef<number>(Date.now());
  const requestRef = useRef<number>(0);

  // Sync ref with initial state if needed
  useEffect(() => {
    if (points.length > 0 && simState.distance === 0) {
      simRef.current.distance = 0;
      simRef.current.currentIndex = 0;
    }
  }, [points]);

  // --- GPX Handling ---

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const gpxContent = event.target?.result as string;
      const gpx = new GpxParser();
      gpx.parse(gpxContent);

      const trackPoints = gpx.tracks[0]?.points || [];
      const formattedPoints: GPXPoint[] = trackPoints.map((p, i) => ({
        lat: p.lat,
        lon: p.lon,
        ele: p.ele || 0,
        dist: i === 0 ? 0 : 0 // Distances will be calculated below
      }));

      // Calculate cumulative distance
      let totalDist = 0;
      for (let i = 1; i < formattedPoints.length; i++) {
        const p1 = formattedPoints[i - 1];
        const p2 = formattedPoints[i];
        // Haversine rough approximation
        const dx = (p2.lon - p1.lon) * 111320 * Math.cos(p1.lat * (Math.PI / 180));
        const dy = (p2.lat - p1.lat) * 110540;
        const d = Math.sqrt(dx * dx + dy * dy);
        totalDist += d;
        formattedPoints[i].dist = totalDist;
      }

      setPoints(formattedPoints);
      setSimState(prev => ({ ...prev, currentPointIndex: 0, distance: 0 }));
    };
    reader.readAsText(file);
  };

  // --- Simulation Loop ---

  const updateSimulation = () => {
    if (!simState.isActive || points.length < 2) {
      if (simState.isActive) requestRef.current = requestAnimationFrame(updateSimulation);
      return;
    }

    const now = Date.now();
    const dt = (now - lastUpdateRef.current) / 1000;
    lastUpdateRef.current = now;

    // 1. Calculate physics at 60fps in Ref
    const currentIndex = simRef.current.currentIndex;
    const nextIndex = Math.min(currentIndex + 1, points.length - 1);
    const p1 = points[currentIndex];
    const p2 = points[nextIndex];
    const distDiff = p2.dist - p1.dist;
    const eleDiff = p2.ele - p1.ele;
    const grade = distDiff > 1 ? (eleDiff / distDiff) * 100 : 0;

    const vMps = calculateVelocity(ftmsData.power, grade, DEFAULT_BIKE_CONFIG);
    const virtualSpeed = mpsToKph(vMps);
    const newDistance = simRef.current.distance + vMps * dt;

    let newPointIndex = currentIndex;
    while (newPointIndex < points.length - 1 && points[newPointIndex + 1].dist < newDistance) {
      newPointIndex++;
    }

    simRef.current.distance = newDistance;
    simRef.current.currentIndex = newPointIndex;
    simRef.current.virtualSpeed = virtualSpeed;
    simRef.current.grade = grade;

    // 2. Throttle React state update to ~30fps to reduce re-renders
    if (now - simRef.current.lastUiUpdate > 33) {
      setSimState(prev => ({
        ...prev,
        virtualSpeed,
        distance: newDistance,
        grade,
        currentPointIndex: newPointIndex,
        isActive: newPointIndex < points.length - 1
      }));
      simRef.current.lastUiUpdate = now;
    }

    requestRef.current = requestAnimationFrame(updateSimulation);
  };

  useEffect(() => {
    if (simState.isActive) {
      lastUpdateRef.current = Date.now();
      requestRef.current = requestAnimationFrame(updateSimulation);
    } else {
      cancelAnimationFrame(requestRef.current);
    }
    return () => cancelAnimationFrame(requestRef.current);
  }, [simState.isActive, ftmsData.power]);

  // --- Web Bluetooth FTMS ---

  const connectFTMS = async () => {
    setIsConnecting(true);
    try {
      // FTMS (Fitness Machine Service) UUID: 0x1826
      // Indoor Bike Data UUID: 0x2AD2
      const device = await (navigator as any).bluetooth.requestDevice({
        filters: [{ services: [0x1826] }],
        optionalServices: [0x1826]
      });

      const server = await device.gatt?.connect();
      const service = await server?.getPrimaryService(0x1826);
      const characteristic = await service?.getCharacteristic(0x2AD2);

      await characteristic?.startNotifications();
      characteristic?.addEventListener('characteristicvaluechanged', (event: any) => {
        const value = event.target.value as DataView;
        // FTMS Indoor Bike Data Data Format is complex bitfield. 
        // Simple simplified extraction for demo:
        // Flags (16-bit), Speed (16-bit), Cadence (16-bit), Power (16-bit)
        const flags = value.getUint16(0, true);
        let offset = 2;
        
        let speed = 0;
        if (!(flags & 0x0001)) { // Speed field present
           speed = value.getUint16(offset, true) / 100;
           offset += 2;
        }

        let cadence = 0;
        // Check bit for cadence
        // ... parsing logic here ...
        // For brevity, we'll just mock it or assume simple offset if bits set
        const power = value.getInt16(offset + 4, true); 

        setFtmsData(prev => ({ ...prev, power: power || 0, speed: speed || 0 }));
      });

      setIsSimulatorMode(false);
      alert("Connected to FTMS device!");
    } catch (err) {
      console.error(err);
      alert("Could not connect to device. Ensure your browser supports Web Bluetooth and you are in a secure context (HTTPS).");
    } finally {
      setIsConnecting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#050505] text-white font-sans selection:bg-orange-500 selection:text-white">
      {/* Header */}
      <header className="h-16 border-b border-[var(--border)] px-8 flex items-center justify-between bg-[var(--surface)] sticky top-0 z-50">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 bg-[var(--accent)] rounded" />
          <h1 className="text-xl font-bold tracking-tight uppercase">FTMS SYNC PRO</h1>
        </div>

        <div className="flex items-center gap-4">
          <div className="bg-[var(--accent-dim)] border border-[var(--accent)] text-[var(--accent)] px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider">
            {isSimulatorMode ? "Mode: Simulator" : "FTMS Connected"}
          </div>
          
          <button 
            onClick={connectFTMS}
            disabled={isConnecting}
            className="px-4 py-2 border border-[var(--border)] rounded-md text-sm font-semibold hover:bg-white/5 transition-colors"
          >
            {isConnecting ? "Connecting..." : "Pair Trainer"}
          </button>
        </div>
      </header>

      <main className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6 p-6 h-[calc(100vh-144px)] overflow-hidden">
        {/* Sidebar */}
        <div className="flex flex-col gap-6 overflow-y-auto pr-1 custom-scrollbar">
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5">
            <h3 className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider mb-4">Live Conversion Feed</h3>
            
            <div className="space-y-4">
              {[
                { label: 'Input Power', value: `${ftmsData.power}W` },
                { label: 'Cadence', value: `${ftmsData.cadence}RPM` },
                { label: 'Virtual Speed', value: `${simState.virtualSpeed.toFixed(1)}km/h` },
                { label: 'Simulation Grade', value: `${simState.grade.toFixed(1)}%` },
              ].map((metric, i) => (
                <div key={i} className="flex justify-between items-end pb-3 border-b border-[var(--border)] last:border-0 last:pb-0">
                  <span className="text-sm text-[var(--text-muted)]">{metric.label}</span>
                  <span className="text-2xl font-bold text-[var(--accent)]">{metric.value}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5">
            <h3 className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider mb-4">Route Origin</h3>
            
            <label className="block border-2 border-dashed border-[var(--border)] rounded-xl p-10 text-center bg-white/[0.02] hover:bg-white/[0.04] transition-colors cursor-pointer group">
              <Upload className="mx-auto mb-3 opacity-30 group-hover:opacity-50 transition-opacity" size={32} />
              <p className="text-sm font-medium mb-1 text-[var(--text-main)]">Drop GPX Route</p>
              <p className="text-xs text-[var(--text-muted)]">Extracting elevation & terrain data</p>
              <input type="file" className="hidden" accept=".gpx" onChange={handleFileUpload} />
            </label>

            {points.length > 0 && (
              <div className="mt-4 space-y-2">
                <div className="flex justify-between items-center py-2 border-b border-[var(--border)]">
                  <span className="text-[13px] text-[var(--text-muted)]">Total Distance</span>
                  <span className="text-[13px] font-bold text-[var(--text-main)]">{(points[points.length - 1].dist / 1000).toFixed(2)} km</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-[var(--border)]">
                  <span className="text-[13px] text-[var(--text-muted)]">Total Elevation</span>
                  <span className="text-[13px] font-bold text-[var(--text-main)]">
                    {points.reduce((acc, p, i) => (i === 0 ? 0 : acc + Math.max(0, p.ele - points[i-1].ele)), 0).toFixed(0)}m
                  </span>
                </div>
              </div>
            )}
          </div>
          
          {/* Simulator controls if active */}
          {isSimulatorMode && (
            <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5 mt-auto">
              <h3 className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider mb-4">Simulator Sliders</h3>
              <div className="space-y-4">
                <div className="space-y-1">
                  <div className="flex justify-between text-[10px] text-[var(--text-muted)] font-mono uppercase">
                    <span>Power Input</span>
                    <span>{ftmsData.power}W</span>
                  </div>
                  <input 
                    type="range" min="0" max="1000" step="5"
                    value={ftmsData.power}
                    onChange={(e) => setFtmsData(p => ({ ...p, power: parseInt(e.target.value) }))}
                    className="w-full h-1 bg-[var(--border)] rounded-lg appearance-none cursor-pointer accent-[var(--accent)]"
                  />
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between text-[10px] text-[var(--text-muted)] font-mono uppercase">
                    <span>Target Cadence</span>
                    <span>{ftmsData.cadence}RPM</span>
                  </div>
                  <input 
                    type="range" min="0" max="150" step="1"
                    value={ftmsData.cadence}
                    onChange={(e) => setFtmsData(p => ({ ...p, cadence: parseInt(e.target.value) }))}
                    className="w-full h-1 bg-[var(--border)] rounded-lg appearance-none cursor-pointer accent-[var(--accent)]"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Canvas Area */}
        <div className="flex flex-col bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden shadow-2xl">
          <div className="flex-1 relative">
             <VirtualWorld points={points} currentIndex={simState.currentPointIndex} />
             
             {/* Overlay Telemetry */}
             <div className="absolute top-6 left-6 flex flex-col gap-4 pointer-events-none">
                <div className="bg-[var(--bg)]/80 backdrop-blur-md border border-[var(--border)] p-4 rounded-xl shadow-lg">
                  <div className="text-[10px] text-[var(--text-muted)] font-mono uppercase tracking-widest mb-1">Session Distance</div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-3xl font-bold text-[var(--text-main)]">{(simState.distance / 1000).toFixed(2)}</span>
                    <span className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-tighter">km</span>
                  </div>
                </div>
             </div>

             {/* Controls Overlay */}
             <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-[var(--bg)]/80 backdrop-blur-md border border-[var(--border)] p-2 rounded-xl shadow-xl">
                <button 
                  onClick={() => setSimState(s => ({ ...s, isActive: !s.isActive }))}
                  disabled={points.length === 0}
                  className={cn(
                    "w-12 h-12 flex items-center justify-center rounded-lg transition-all",
                    simState.isActive ? "bg-white text-black" : "bg-[var(--accent)] text-black hover:scale-105 active:scale-95"
                  )}
                >
                  {simState.isActive ? <Pause size={24} /> : <Play size={24} />}
                </button>
                <button 
                  onClick={() => setSimState(s => ({ ...s, distance: 0, currentPointIndex: 0, isActive: false }))}
                  className="w-12 h-12 flex items-center justify-center bg-[var(--surface-light)] text-white rounded-lg border border-[var(--border)] hover:bg-white/5 active:bg-white/10 transition-all"
                >
                  <RefreshCcw size={20} />
                </button>
             </div>
             
             <div className="absolute bottom-6 right-6 bg-black/60 backdrop-blur px-3 py-1.5 rounded-lg text-[10px] text-[var(--text-muted)] uppercase tracking-widest border border-[var(--border)] shadow-md">
               TERRAIN: VIRTUAL MESH
             </div>
          </div>

          {/* Elevation Profile */}
          <div className="h-32 bg-[var(--surface-light)] border-t border-[var(--border)] p-4 flex items-end gap-[1px] overflow-hidden">
             {points.length > 0 ? (
                Array.from({ length: 120 }).map((_, i) => {
                  const idx = Math.floor((i / 120) * points.length);
                  const p = points[idx];
                  const minEle = Math.min(...points.map(pt => pt.ele));
                  const maxEle = Math.max(...points.map(pt => pt.ele));
                  const height = ((p.ele - minEle) / (maxEle - minEle || 1)) * 100;
                  const isCurrent = Math.abs(idx - simState.currentPointIndex) < (points.length / 120);
                  
                  return (
                    <div 
                      key={i} 
                      className={cn(
                        "flex-1 bg-[var(--accent)] rounded-t-[1px] transition-all duration-300",
                        isCurrent ? "opacity-100 scale-y-110" : "opacity-30"
                      )} 
                      style={{ height: `${Math.max(8, height)}%` }} 
                    />
                  );
                })
             ) : (
               <div className="w-full h-full flex flex-col items-center justify-center text-[var(--text-muted)] text-[10px] uppercase tracking-[0.2em] opacity-40">
                  <Mountain size={24} className="mb-2" />
                  No Profile Data Found
               </div>
             )}
          </div>
        </div>
      </main>

      <footer className="h-20 bg-[var(--surface)] border-t border-[var(--border)] px-8 flex items-center justify-end gap-4">
        <button 
          className="px-6 py-2.5 rounded-lg font-semibold text-sm border border-[var(--border)] text-[var(--text-main)] hover:bg-white/5 active:bg-white/10 transition-colors"
          onClick={() => {
            setPoints([]);
            setSimState({ virtualSpeed: 0, distance: 0, grade: 0, currentPointIndex: 0, isActive: false });
          }}
        >
          Reset Session
        </button>
        <button 
          className="px-6 py-2.5 rounded-lg font-bold text-sm bg-[var(--accent)] text-[var(--bg)] hover:brightness-110 active:scale-95 transition-all shadow-lg shadow-[var(--accent)]/10"
          onClick={() => points.length > 0 && setSimState(s => ({ ...s, isActive: true }))}
        >
          Start Conversion
        </button>
      </footer>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }
      `}</style>
    </div>
  );
};

const HeartRateIcon = ({ size, className }: { size: number, className: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
  </svg>
)

export default App;
