import React, { useEffect, useRef } from 'react';
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

  useEffect(() => {
    if (!containerRef.current) return;

    // Setup
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0A0A0B); // Theme bg
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(75, containerRef.current.clientWidth / containerRef.current.clientHeight, 0.1, 2000);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight);
    containerRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const sunLight = new THREE.DirectionalLight(0xffffff, 0.8);
    sunLight.position.set(50, 100, 50);
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
      requestAnimationFrame(animate);
      if (rendererRef.current && sceneRef.current && cameraRef.current) {
        rendererRef.current.render(sceneRef.current, cameraRef.current);
      }
    };
    animate();

    return () => {
      window.removeEventListener('resize', handleResize);
      renderer.dispose();
      if (containerRef.current) containerRef.current.removeChild(renderer.domElement);
    };
  }, []);

  // Update Points / Path
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || points.length === 0) return;

    // Remove old path
    const oldPath = scene.getObjectByName('gpx-path');
    if (oldPath) scene.remove(oldPath);

    const oldFloor = scene.getObjectByName('floor');
    if (oldFloor) scene.remove(oldFloor);

    // Create Path
    const geometry = new THREE.BufferGeometry();
    const vertices: number[] = [];
    
    // Scale factors to make it visible
    const scale = 100; // Degrees to meters (rough)
    const pointsNormalized = points.map(p => ({
      x: (p.lon - points[0].lon) * scale * 500,
      y: p.ele / 10, // vertical exaggeration
      z: (p.lat - points[0].lat) * scale * 500
    }));

    pointsNormalized.forEach(p => {
      vertices.push(p.x, p.y, p.z);
    });

    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    const material = new THREE.LineBasicMaterial({ color: 0x00F59B, linewidth: 3 });
    const line = new THREE.Line(geometry, material);
    line.name = 'gpx-path';
    scene.add(line);

    // Floor (Grid)
    const gridHelper = new THREE.GridHelper(1000, 50);
    gridHelper.name = 'floor';
    scene.add(gridHelper);

    // Bike marker
    if (!bikeRef.current) {
      const bikeGeo = new THREE.BoxGeometry(1, 2, 3);
      const bikeMat = new THREE.MeshLambertMaterial({ color: 0xff0000 });
      const bike = new THREE.Mesh(bikeGeo, bikeMat);
      bikeRef.current = new THREE.Group();
      bikeRef.current.add(bike);
      scene.add(bikeRef.current);
    }
  }, [points]);

  // Update Camera/Bike Position
  useEffect(() => {
    if (!points[currentIndex] || !bikeRef.current || !cameraRef.current) return;

    const scale = 100 * 500;
    const p = points[currentIndex];
    const x = (p.lon - points[0].lon) * scale;
    const y = p.ele / 10 + 2; // Offset from ground
    const z = (p.lat - points[0].lat) * scale;

    bikeRef.current.position.set(x, y - 2, z);
    
    // Update camera to follow
    const offset = new THREE.Vector3(0, 10, -20);
    cameraRef.current.position.set(x + offset.x, y + offset.y, z + offset.z);
    cameraRef.current.lookAt(x, y, z);
  }, [currentIndex, points]);

  return (
    <div 
      ref={containerRef} 
      id="virtual-world-container"
      className="w-full h-full rounded-xl overflow-hidden bg-slate-900 border border-slate-800"
    />
  );
};
