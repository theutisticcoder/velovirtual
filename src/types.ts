export interface GPXPoint {
  lat: number;
  lon: number;
  ele: number;
  dist: number; // Cumulative distance
}

export interface FTMSData {
  power: number; // Watts
  cadence: number; // RPM
  speed: number; // km/h (raw from machine)
  heartRate: number; // BPM
}

export interface SimulationState {
  virtualSpeed: number; // km/h (calculated)
  distance: number; // Meters
  grade: number; // Percentage
  currentPointIndex: number;
  isActive: boolean;
}

export interface BikeConfig {
  weightBike: number; // kg
  weightRider: number; // kg
  crr: number; // Rolling resistance coefficient
  cda: number; // Aerodynamic drag coefficient
}

export const DEFAULT_BIKE_CONFIG: BikeConfig = {
  weightBike: 9,
  weightRider: 75,
  crr: 0.005,
  cda: 0.32,
};
