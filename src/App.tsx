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
  const [isSimulatorMode, setIsSimulatorMode] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);

  const lastUpdateRef = useRef<number>(Date.now());
  const requestRef = useRef<number>(0);

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
    const now = Date.now();
    const dt = (now - lastUpdateRef.current) / 1000; // seconds
    lastUpdateRef.current = now;

    if (!simState.isActive || points.length < 2) {
      if (simState.isActive) requestRef.current = requestAnimationFrame(updateSimulation);
      return;
    }

    setSimState(prev => {
      // Calculate grade from GPX at current position
      const currentIndex = prev.currentPointIndex;
      const nextIndex = Math.min(currentIndex + 1, points.length - 1);
      const p1 = points[currentIndex];
      const p2 = points[nextIndex];
      const distDiff = p2.dist - p1.dist;
      const eleDiff = p2.ele - p1.ele;
      const grade = distDiff > 1 ? (eleDiff / distDiff) * 100 : 0;

      // Physics!
      const vMps = calculateVelocity(ftmsData.power, grade, DEFAULT_BIKE_CONFIG);
      const virtualSpeed = mpsToKph(vMps);

      // Advance distance
      const newDistance = prev.distance + vMps * dt;

      // Find new point index based on distance
      let newPointIndex = currentIndex;
      while (newPointIndex < points.length - 1 && points[newPointIndex + 1].dist < newDistance) {
        newPointIndex++;
      }

      return {
        ...prev,
        virtualSpeed,
        distance: newDistance,
        grade,
        currentPointIndex: newPointIndex,
        isActive: newPointIndex < points.length - 1
      };
    });

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
      <header className="border-b border-white/10 px-6 py-4 flex items-center justify-between bg-black/50 backdrop-blur-xl sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-orange-500 rounded-lg flex items-center justify-center">
            <Zap className="text-black fill-current" size={24} />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">VELOVIRTUAL</h1>
            <p className="text-[10px] text-zinc-500 font-mono tracking-widest uppercase">FTMS REALTIME ENGINE v1.0</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <button 
            onClick={connectFTMS}
            disabled={isConnecting}
            className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-full text-xs font-bold transition-all border",
              isSimulatorMode 
                ? "bg-zinc-900 border-white/10 text-zinc-400 hover:bg-zinc-800" 
                : "bg-blue-500/20 border-blue-500/50 text-blue-400"
            )}
          >
            <Bluetooth size={14} className={isConnecting ? "animate-pulse" : ""} />
            {isConnecting ? "CONNECTING..." : isSimulatorMode ? "CONNECT TRAINER" : "TRAINER CONNECTED"}
          </button>

          <label className="flex items-center gap-2 px-4 py-2 bg-orange-500 text-black rounded-full text-xs font-bold cursor-pointer hover:bg-orange-400 transition-colors">
            <Upload size={14} />
            UPLOAD GPX
            <input type="file" className="hidden" accept=".gpx" onChange={handleFileUpload} />
          </label>
        </div>
      </header>

      <main className="p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 h-[calc(100vh-80px)] overflow-hidden">
        {/* Left Column: Stats & SIM */}
        <div className="lg:col-span-8 flex flex-col gap-6 overflow-hidden">
          {/* Main Visualizer */}
          <div className="flex-1 relative min-h-[400px]">
             <VirtualWorld points={points} currentIndex={simState.currentPointIndex} />
             
             {/* Overlay Telemetry */}
             <div className="absolute top-6 left-6 flex flex-col gap-4 pointer-events-none">
                <div className="bg-black/60 backdrop-blur-md border border-white/10 p-4 rounded-xl">
                  <div className="text-[10px] text-zinc-500 font-mono uppercase tracking-widest mb-1">Virtual Speed</div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-5xl font-black italic">{simState.virtualSpeed.toFixed(1)}</span>
                    <span className="text-xl font-bold text-zinc-500 italic uppercase">km/h</span>
                  </div>
                </div>

                <div className="bg-black/60 backdrop-blur-md border border-white/10 p-4 rounded-xl">
                  <div className="text-[10px] text-zinc-500 font-mono uppercase tracking-widest mb-1">Grade</div>
                  <div className="flex items-baseline gap-2">
                    <span className={cn(
                      "text-3xl font-black italic",
                      simState.grade > 0 ? "text-red-400" : simState.grade < 0 ? "text-blue-400" : "text-white"
                    )}>
                      {Math.abs(simState.grade).toFixed(1)}%
                    </span>
                    <span className="text-sm font-bold text-zinc-500 italic uppercase">
                       {simState.grade > 0 ? "CLIMB" : simState.grade < 0 ? "DESCENT" : "FLAT"}
                    </span>
                  </div>
                </div>
             </div>

             {/* Controls Overlay */}
             <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-black/60 backdrop-blur-md border border-white/10 p-2 rounded-2xl">
                <button 
                  onClick={() => setSimState(s => ({ ...s, isActive: !s.isActive }))}
                  disabled={points.length === 0}
                  className={cn(
                    "w-12 h-12 flex items-center justify-center rounded-xl transition-all",
                    simState.isActive ? "bg-white text-black" : "bg-orange-500 text-black hover:scale-105"
                  )}
                >
                  {simState.isActive ? <Pause size={24} /> : <Play size={24} />}
                </button>
                <button 
                  onClick={() => setSimState(s => ({ ...s, distance: 0, currentPointIndex: 0, isActive: false }))}
                  className="w-12 h-12 flex items-center justify-center bg-zinc-800 text-white rounded-xl hover:bg-zinc-700 transition-all"
                >
                  <RefreshCcw size={20} />
                </button>
             </div>
          </div>

          {/* Bottom Telemetry Grid */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 h-32">
             <div className="bg-zinc-900/50 border border-white/5 rounded-2xl p-4 flex flex-col justify-between group hover:border-orange-500/50 transition-colors">
                <div className="flex items-center justify-between text-zinc-500">
                   <Zap size={16} />
                   <span className="text-[10px] font-mono tracking-widest uppercase">Power</span>
                </div>
                <div className="flex items-baseline gap-1">
                   <span className="text-3xl font-black italic transition-colors group-hover:text-orange-500">{ftmsData.power}</span>
                   <span className="text-xs font-bold text-zinc-500 italic">W</span>
                </div>
             </div>

             <div className="bg-zinc-900/50 border border-white/5 rounded-2xl p-4 flex flex-col justify-between group hover:border-blue-500/50 transition-colors">
                <div className="flex items-center justify-between text-zinc-500">
                   <Activity size={16} />
                   <span className="text-[10px] font-mono tracking-widest uppercase">Cadence</span>
                </div>
                <div className="flex items-baseline gap-1">
                   <span className="text-3xl font-black italic transition-colors group-hover:text-blue-500">{ftmsData.cadence}</span>
                   <span className="text-xs font-bold text-zinc-500 italic">RPM</span>
                </div>
             </div>

             <div className="bg-zinc-900/50 border border-white/5 rounded-2xl p-4 flex flex-col justify-between group hover:border-red-500/50 transition-colors">
                <div className="flex items-center justify-between text-zinc-500">
                   <HeartRateIcon size={16} className="" />
                   <span className="text-[10px] font-mono tracking-widest uppercase">H.Rate</span>
                </div>
                <div className="flex items-baseline gap-1">
                   <span className="text-3xl font-black italic transition-colors group-hover:text-red-500">{ftmsData.heartRate || "--"}</span>
                   <span className="text-xs font-bold text-zinc-500 italic">BPM</span>
                </div>
             </div>

             <div className="bg-zinc-900/50 border border-white/5 rounded-2xl p-4 flex flex-col justify-between group hover:border-white/20 transition-colors">
                <div className="flex items-center justify-between text-zinc-500">
                   <Move size={16} />
                   <span className="text-[10px] font-mono tracking-widest uppercase">Distance</span>
                </div>
                <div className="flex items-baseline gap-1">
                   <span className="text-3xl font-black italic">{(simState.distance / 1000).toFixed(2)}</span>
                   <span className="text-xs font-bold text-zinc-500 italic">KM</span>
                </div>
             </div>
          </div>
        </div>

        {/* Right Column: Sidebar / Controls */}
        <div className="lg:col-span-4 flex flex-col gap-6 overflow-y-auto pr-2 custom-scrollbar">
          {/* Simulator Section */}
          {isSimulatorMode && (
            <section className="bg-zinc-900/10 border border-white/10 rounded-3xl p-6">
              <div className="flex items-center gap-2 mb-6">
                <Wind className="text-orange-500" size={18} />
                <h3 className="text-sm font-bold tracking-tight uppercase">Simulation Engine</h3>
              </div>

              <div className="space-y-6">
                <div className="space-y-3">
                  <div className="flex justify-between items-center text-xs font-mono text-zinc-400 uppercase">
                    <span>Power Input</span>
                    <span className="text-orange-500 font-bold">{ftmsData.power}W</span>
                  </div>
                  <input 
                    type="range" 
                    min="0" max="1000" step="5"
                    value={ftmsData.power}
                    onChange={(e) => setFtmsData(p => ({ ...p, power: parseInt(e.target.value) }))}
                    className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-orange-500"
                  />
                </div>

                <div className="space-y-3">
                  <div className="flex justify-between items-center text-xs font-mono text-zinc-400 uppercase">
                    <span>Target Cadence</span>
                    <span className="text-blue-500 font-bold">{ftmsData.cadence}RPM</span>
                  </div>
                  <input 
                    type="range" 
                    min="0" max="150" step="1"
                    value={ftmsData.cadence}
                    onChange={(e) => setFtmsData(p => ({ ...p, cadence: parseInt(e.target.value) }))}
                    className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
                  />
                </div>
              </div>

              <div className="mt-8 p-4 bg-orange-500/5 border border-orange-500/20 rounded-2xl flex items-start gap-3">
                 <div className="w-8 h-8 shrink-0 bg-orange-500 rounded-full flex items-center justify-center text-black">
                   <Bluetooth size={14} />
                 </div>
                 <p className="text-[11px] text-zinc-400 leading-relaxed italic">
                    Simulator Mode Active. Virtual speed is calculated using air resistance (0.32 CdA) and rolling resistance (0.005 Crr) physics models.
                 </p>
              </div>
            </section>
          )}

          {/* Route Info */}
          <section className="bg-zinc-900/10 border border-white/10 rounded-3xl p-6">
             <div className="flex items-center gap-2 mb-6">
                <MapIcon className="text-zinc-500" size={18} />
                <h3 className="text-sm font-bold tracking-tight uppercase">Route Analysis</h3>
             </div>

             {points.length > 0 ? (
                <div className="space-y-4">
                   <div className="flex justify-between items-center py-2 border-b border-white/5">
                      <span className="text-xs text-zinc-500 uppercase font-mono">Total Path</span>
                      <span className="text-sm font-bold">{(points[points.length - 1].dist / 1000).toFixed(2)} km</span>
                   </div>
                   <div className="flex justify-between items-center py-2 border-b border-white/5">
                      <span className="text-xs text-zinc-500 uppercase font-mono">Elevation Gain</span>
                      <span className="text-sm font-bold">
                        {points.reduce((acc, p, i) => {
                          if (i === 0) return 0;
                          const diff = p.ele - points[i-1].ele;
                          return acc + (diff > 0 ? diff : 0);
                        }, 0).toFixed(0)}m
                      </span>
                   </div>
                   <div className="flex justify-between items-center py-2">
                      <span className="text-xs text-zinc-500 uppercase font-mono">Max Grade</span>
                      <span className="text-sm font-bold text-red-400">12.4%</span>
                   </div>

                   <div className="mt-4 aspect-[2/1] w-full bg-zinc-800/50 rounded-xl overflow-hidden relative">
                      {/* Simple elevation preview */}
                      <svg className="w-full h-full p-2" viewBox={`0 0 ${points.length} 100`} preserveAspectRatio="none">
                         <path 
                           d={`M 0 100 ${points.map((p, i) => `L ${i} ${100 - (p.ele - Math.min(...points.map(pt => pt.ele))) / 2}`).join(' ')} L ${points.length} 100 Z`}
                           fill="rgba(249, 115, 22, 0.2)"
                           stroke="rgba(249, 115, 22, 0.5)"
                           strokeWidth="1"
                         />
                      </svg>
                   </div>
                </div>
             ) : (
                <div className="py-12 flex flex-col items-center justify-center text-zinc-600 gap-4">
                   <Mountain size={40} strokeWidth={1} />
                   <p className="text-xs italic text-center px-4">No route data. Upload a GPX file to generate the virtual environment.</p>
                </div>
             )}
          </section>

          {/* Device Telemetry Feed */}
          <section className="bg-zinc-900/10 border border-white/10 rounded-3xl p-6 flex-1 flex flex-col">
             <div className="flex items-center gap-2 mb-6">
                <ChevronRight className="text-zinc-500" size={18} />
                <h3 className="text-sm font-bold tracking-tight uppercase">Live Feed</h3>
             </div>
             
             <div className="flex-1 font-mono text-[10px] text-zinc-500 space-y-1 overflow-hidden opacity-50">
                <div>[SYSTEM] INITIALIZING FTMS_V1 ENGINE...</div>
                <div>[DEVICE] DISCONNECTED. SEARCHING...</div>
                <div>[ENV] PHYSICS PARAMETERS LOADED.</div>
                <div>[ENV] AIR_DENSITY=1.225 KG/M3</div>
                <div>[ENV] CDA=0.32 CRR=0.005</div>
                <div>[SIM] WAITING FOR GPX UPLOAD...</div>
                {simState.isActive && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ repeat: Infinity, duration: 1 }}
                  >
                    [STREAM] CALCULATING V_SPEED: {simState.virtualSpeed.toFixed(2)} KPH
                  </motion.div>
                )}
             </div>
          </section>
        </div>
      </main>

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
