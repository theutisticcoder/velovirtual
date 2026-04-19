import { BikeConfig } from "../types";

const G = 9.80665;
const RHO = 1.225; // Air density at sea level

/**
 * Calculates current virtual speed in m/s given power and conditions.
 * Uses an iterative solver for the cubic equation of power.
 */
export function calculateVelocity(
  power: number,
  grade: number, // percentage (e.g. 5 for 5%)
  config: BikeConfig
): number {
  if (power <= 0) return 0;

  const mass = config.weightBike + config.weightRider;
  const theta = Math.atan(grade / 100);
  const sinTheta = Math.sin(theta);
  const cosTheta = Math.cos(theta);

  // Constants for the equation P = A*v^3 + B*v
  const A = 0.5 * RHO * config.cda;
  const B = mass * G * (sinTheta + config.crr * cosTheta);

  // Solve for v using Newton's method or binary search
  // Binary search for safety and simplicity in range [0, 50] m/s
  let low = 0;
  let high = 50; // max ~180 km/h
  
  for (let i = 0; i < 20; i++) {
    const mid = (low + high) / 2;
    const pMid = A * Math.pow(mid, 3) + B * mid;
    
    if (pMid < power) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return (low + high) / 2;
}

export function mpsToKph(mps: number): number {
  return mps * 3.6;
}

export function kphToMps(kph: number): number {
  return kph / 3.6;
}
