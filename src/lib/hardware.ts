/** Facts transcribed from the owner's assembly photos and product specification.
 * Link lengths below are visual proportions, not measured fabrication dimensions.
 * No servo travel / horn offset / direction was provided. Never infer these from
 * the product's separate “maximum claw opening 180°” claim.
 */
export const HARDWARE_PROFILE = 'sg90-linkage-4-v1';
export const JOINT_IDS = ['J1', 'J2', 'J3', 'J4'] as const;
export type HardwareJoint = typeof JOINT_IDS[number];
export const JOINTS = {
  J1: { name: 'Base', motion: 'Base rotation', detail: 'One vertical axis turns the complete upper assembly.' },
  J2: { name: 'Shoulder', motion: 'Upper arm up / down', detail: 'A base-mounted servo raises and lowers the main arm.' },
  J3: { name: 'Forearm', motion: 'Forearm reach / retract', detail: 'The opposite base-mounted servo drives the forearm through a crank and connecting rod. The elbow is a passive pivot.' },
  J4: { name: 'Gripper', motion: 'Gripper open / close', detail: 'One end-mounted servo drives both jaws through meshing gears. There is no independent wrist motor.' },
} as const;
export interface ServoCalibration { min: number; max: number; zero: number; direction: 1 | -1 }
export type ServoLimits = Record<HardwareJoint, ServoCalibration | null>;
export const pendingCalibration = (): ServoLimits => ({ J1: null, J2: null, J3: null, J4: null });
export function validCalibration(value: ServoCalibration) {
  return [value.min,value.max,value.zero].every(Number.isFinite) && value.min < value.max && value.zero >= value.min && value.zero <= value.max && (value.direction === 1 || value.direction === -1);
}
/** Hardware adapters must supply measured limits before converting any command. */
export function servoCommand(joint: HardwareJoint, relativeDegrees: number, limits: ServoLimits) {
  const calibration = limits[joint];
  if (!calibration || !validCalibration(calibration)) throw new Error(`${joint}: servo calibration is required.`);
  if (!Number.isFinite(relativeDegrees)) throw new Error('The angle must be finite.');
  const requested = calibration.zero + calibration.direction * relativeDegrees;
  return Math.max(calibration.min, Math.min(calibration.max, requested));
}
/** Published board facts for diagnosis. They describe the board, never the owner's wiring or measurements. */
const CONTROLLER_PROFILES: Partial<Record<string, { board: string; mcu: string; clockMHz: number; logicVoltage: number; sketchFlashBytes: number; sramBytes: number; eepromBytes: number; firmware: string; fqbn: string; pins: Record<string, string>; notes: string[] }>> = {
  'Arduino Uno': {
    board: 'Arduino Uno R3', mcu: 'ATmega328P', clockMHz: 16, logicVoltage: 5, sketchFlashBytes: 32256, sramBytes: 2048, eepromBytes: 1024,
    firmware: 'Arduino sketch (.ino, C++) on the AVR core', fqbn: 'arduino:avr:uno',
    pins: { digital: 'D0–D13', analog: 'A0–A5, 10-bit analogRead (0–1023)', analogWrite: 'D3, D5, D6, D9, D10, D11', serial: 'D0 RX / D1 TX, shared with USB serial' },
    notes: [
      'analogWrite() runs at about 490 Hz (980 Hz on D5/D6); it is not a 50 Hz servo signal. Servos need the Servo library or a timer.',
      'The Servo library uses Timer1 and disables analogWrite() on D9 and D10.',
      'int is 16-bit and double is 32-bit on AVR, unlike ESP32 and STM32.',
      'Opening the serial port resets the board, so the sketch restarts when a serial monitor connects.',
      'The USB fuse limits supply to about 500 mA; servos under load need an external 5 V supply sharing GND with the board.',
    ],
  },
};
export function pinPlaceholder(controller: string) {
  if (/^arduino/i.test(controller)) return 'e.g. D9';
  if (/^stm32/i.test(controller)) return 'e.g. PA8';
  if (/esp32/i.test(controller)) return 'e.g. GPIO 18';
  return 'e.g. D9 or GPIO 18';
}
export function hardwareDescription(controller = 'ESP32') {
  return {
    profile: HARDWARE_PROFILE, controller, controllerProfile: CONTROLLER_PROFILES[controller], servo: 'SG90', servoCount: 4,
    armDOF: 3, gripperDOF: 1, independentWrist: false,
    axes: JOINTS, servoCalibration: pendingCalibration(),
    specification: { homeSizeCm: [18,9.5,18], maximumExtendedLengthCm: 25, weightG: 160, clawOpeningClaimDeg: 180 },
    calibrationNote: 'Per-servo min/max, zero and direction were not supplied. The claw opening claim is not a servo travel calibration. Preview proportions and poses are illustrative.',
  };
}
