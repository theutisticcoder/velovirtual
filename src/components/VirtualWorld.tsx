import React, { useEffect, useRef, useMemo } from 'react';
import * as THREE from 'three';
import { GPXPoint } from '../types';

interface VirtualWorldProps {
  points: GPXPoint[];
  currentIndex: number;
}

export const VirtualWorld: React.FC<VirtualWorldProps> = ({ points, currentIndex }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const bikeRef = useRef<THREE.Group | null>(null);
  const frameIdRef = useRef<number>(0);
  
  // Track normalized coordinates
  const trackData = useMemo(() => {
    if (points.length < 2) return null;
    const scale = 50000;
    const elevationScale = 0.1;
    
    // 1. Create world points with consistent scaling
    const worldPoints = points.map(p => new THREE.Vector3(
      (p.lon - points[0].lon) * scale,
      p.ele * elevationScale,
      (p.lat - points[0].lat) * scale
    ));

    const curve = new THREE.CatmullRomCurve3(worldPoints);
    
    // 2. Pre-generate a spatial grid for fast terrain lookup
    // Find bounds for the grid
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    worldPoints.forEach(p => {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    });

    const padding = 500;
    const gridDim = 40; // Resolution of heightmap cache
    const heightMap: { [key: string]: number } = {};
    
    // Populate grid with nearest elevations
    for (let j = 0; j < worldPoints.length; j += 5) {
      const p = worldPoints[j];
      const gx = Math.floor((p.x - minX + padding) / gridDim);
      const gz = Math.floor((p.z - minZ + padding) / gridDim);
      const key = `${gx},${gz}`;
      if (heightMap[key] === undefined || Math.abs(p.y) > Math.abs(heightMap[key])) {
        heightMap[key] = p.y;
      }
    }

    return { worldPoints, curve, minX, maxX, minZ, maxZ, padding, gridDim, heightMap };
  }, [points]);

  useEffect(() => {
    if (!containerRef.current) return;

    // Setup
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0A0A0B);
    scene.fog = new THREE.FogExp2(0x0A0A0B, 0.002);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(65, containerRef.current.clientWidth / containerRef.current.clientHeight, 1, 5000);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight);
    renderer.shadowMap.enabled = true;
    containerRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Lights
    const ambientLight = new THREE.AmbientLight(0x404040, 0.5);
    scene.add(ambientLight);

    const sunLight = new THREE.DirectionalLight(0xffffff, 1.2);
    sunLight.position.set(100, 200, 100);
    sunLight.castShadow = true;
    scene.add(sunLight);

    // Initial Resize
    const handleResize = () => {
      if (!containerRef.current || !cameraRef.current || !rendererRef.current) return;
      cameraRef.current.aspect = containerRef.current.clientWidth / containerRef.current.clientHeight;
      cameraRef.current.updateProjectionMatrix();
      rendererRef.current.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight);
    };
    window.addEventListener('resize', handleResize);

    // Animation Loop
    const animate = () => {
      frameIdRef.current = requestAnimationFrame(animate);
      if (rendererRef.current && sceneRef.current && cameraRef.current) {
        rendererRef.current.render(sceneRef.current, cameraRef.current);
      }
    };
    animate();

    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(frameIdRef.current);
      renderer.dispose();
      if (containerRef.current && renderer.domElement.parentNode) {
        containerRef.current.removeChild(renderer.domElement);
      }
    };
  }, []);

  // Update Points / Path / Terrain
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !trackData) return;

    // Clear existing
    const toRemove: THREE.Object3D[] = [];
    scene.traverse(child => {
      if (child.name === 'dynamic-element') toRemove.push(child);
    });
    toRemove.forEach(obj => scene.remove(obj));

    const { worldPoints, curve } = trackData;

    // 1. Realistic Road Mesh (Ribbon)
    const roadPoints = curve.getPoints(points.length * 2);
    const roadGeometry = new THREE.TubeGeometry(curve, points.length * 2, 0.5, 8, false);
    const roadMaterial = new THREE.MeshStandardMaterial({ 
      color: 0x222222, 
      roughness: 0.8,
      metalness: 0.2
    });
    const roadMesh = new THREE.Mesh(roadGeometry, roadMaterial);
    roadMesh.name = 'dynamic-element';
    roadMesh.receiveShadow = true;
    scene.add(roadMesh);

    // 2. Glow Path (Accent)
    const lineGeo = new THREE.BufferGeometry().setFromPoints(roadPoints);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x00F59B, linewidth: 2, transparent: true, opacity: 0.8 });
    const line = new THREE.Line(lineGeo, lineMat);
    line.position.y += 0.1;
    line.name = 'dynamic-element';
    scene.add(line);

    // 3. Virtual Terrain
    const { minX, maxX, minZ, maxZ, padding, gridDim, heightMap } = trackData;
    const terrainWidth = (maxX - minX) + padding * 2;
    const terrainHeight = (maxZ - minZ) + padding * 2;
    const segments = 48; // Slightly lower for smoother look and perf

    const terrainGeo = new THREE.PlaneGeometry(terrainWidth, terrainHeight, segments, segments);
    terrainGeo.rotateX(-Math.PI / 2);
    
    // Displace terrain using fast grid lookup
    const positions = terrainGeo.attributes.position.array as Float32Array;
    const center = new THREE.Vector2((minX + maxX) / 2, (minZ + maxZ) / 2);
    
    for (let i = 0; i < positions.length; i += 3) {
      const vx = positions[i] + center.x;
      const vz = positions[i+2] + center.y;
      
      const gx = Math.floor((vx - minX + padding) / gridDim);
      const gz = Math.floor((vz - minZ + padding) / gridDim);
      
      let baseHeight = -10;
      let isNearTrack = false;

      // Check surrounding grid cells for influence
      for(let dx = -2; dx <= 2; dx++) {
        for(let dz = -2; dz <= 2; dz++) {
          const key = `${gx + dx},${gz + dz}`;
          if (heightMap[key] !== undefined) {
             const distToTrack = Math.sqrt((dx * gridDim) ** 2 + (dz * gridDim) ** 2);
             const weight = Math.exp(-distToTrack * 0.02);
             baseHeight = Math.max(baseHeight, heightMap[key] * weight);
             if (distToTrack < gridDim) isNearTrack = true;
          }
        }
      }

      // Add broader terrain variation
      const noise = (Math.sin(vx * 0.002) + Math.cos(vz * 0.002)) * 15;
      
      // If near track, favor track height to avoid road being buried
      positions[i+1] = baseHeight + (isNearTrack ? 0 : noise);
    }
    terrainGeo.computeVertexNormals();

    const terrainMat = new THREE.MeshStandardMaterial({ 
      color: 0x0A0A0B, 
      roughness: 1,
      metalness: 0,
      flatShading: true
    });
    const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
    terrainMesh.position.set((minX + maxX) / 2, -1, (minZ + maxZ) / 2);
    terrainMesh.name = 'dynamic-element';
    terrainMesh.receiveShadow = true;
    scene.add(terrainMesh);

    // 4. Grid Overlay (Brutalist theme)
    const gridMat = new THREE.MeshBasicMaterial({ color: 0x00F59B, wireframe: true, transparent: true, opacity: 0.05 });
    const gridMesh = new THREE.Mesh(terrainGeo, gridMat);
    gridMesh.position.copy(terrainMesh.position);
    gridMesh.position.y += 0.2;
    gridMesh.name = 'dynamic-element';
    scene.add(gridMesh);

    // Bike marker setup
    if (bikeRef.current) scene.remove(bikeRef.current);
    const bikeGroup = new THREE.Group();
    const bikeBody = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1, 1.5), new THREE.MeshStandardMaterial({ color: 0x00F59B, emissive: 0x00F59B, emissiveIntensity: 0.5 }));
    bikeBody.castShadow = true;
    bikeGroup.add(bikeBody);
    bikeRef.current = bikeGroup;
    scene.add(bikeGroup);

  }, [trackData]);

  // Smooth follow camera
  useEffect(() => {
    if (!trackData || !currentIndex || !bikeRef.current || !cameraRef.current) return;
    
    const { curve } = trackData;
    const progress = currentIndex / points.length;
    const safeProgress = Math.max(0, Math.min(0.999, progress));
    
    const pos = curve.getPointAt(safeProgress);
    const lookAtPos = curve.getPointAt(Math.min(0.999, safeProgress + 0.001));
    
    // Offset bike to be ON TOP of road tube (tube radius is 0.5)
    const bikePos = pos.clone().add(new THREE.Vector3(0, 0.6, 0));
    
    bikeRef.current.position.lerp(bikePos, 0.4);
    bikeRef.current.lookAt(lookAtPos.clone().add(new THREE.Vector3(0, 0.6, 0)));
    
    const cameraOffset = new THREE.Vector3(0, 4, -10);
    cameraOffset.applyQuaternion(bikeRef.current.quaternion);
    const targetCameraPos = bikePos.clone().add(cameraOffset);
    
    cameraRef.current.position.lerp(targetCameraPos, 0.15);
    cameraRef.current.lookAt(bikePos);
    
  }, [currentIndex, trackData, points.length]);

  return (
    <div 
      ref={containerRef} 
      className="w-full h-full bg-black"
    />
  );
};
