/** Facts transcribed from the owner's assembly photos and product specification.
 * Link lengths below are visual proportions, not measured fabrication dimensions.
 * Servo home angles, the gripper range and (except for the base) what a larger angle
 * does were recorded only for the Arduino Uno sketch (`MEASURED_UNO_ARM`); other
 * controllers have none. Never infer servo travel from the product's separate
 * “maximum claw opening 180°” claim.
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
const UNO_ARM_CALIBRATION: ServoLimits = {
  J1: { min: 10, max: 170, zero: 90, direction: 1 }, J2: { min: 120, max: 180, zero: 145, direction: 1 },
  J3: { min: 68, max: 150, zero: 100, direction: 1 }, J4: { min: 98, max: 170, zero: 98, direction: 1 },
};
/** The owner's arm driven by the Uno sketch, recorded 2026-10-30, joint limits updated 2026-11-06. The owner judged each held angle by eye;
 * nothing was measured with an instrument. Angles are the sketch's command angles and do not carry over to other firmware. */
export const MEASURED_UNO_ARM = {
  recorded: '2026-10-30', firmware: 'ARDUINO_UNO_ARM_V4', sketch: 'Arduino_Uno_Arm_Test/Arduino_Uno_Arm_Test.ino',
  method: 'The Uno held one joint at a time at a commanded angle and the owner judged the result by eye. No angle was measured with an instrument.',
  pins: { J1: 'D9', J2: 'D10', J3: 'D11', J4: 'D12' },
  calibration: UNO_ARM_CALIBRATION,
  directionConvention: 'direction 1: a positive relative command increases the sketch angle. increasingAngle gives what that does on the arm.',
  home: { J1: '90°: base faces straight ahead', J2: '145°: upper arm vertical (140° leans slightly back, 150° slightly forward)', J3: '100°: forearm a little below level (137° is level)', J4: '98°: jaws closed without the servo buzzing' },
  increasingAngle: { J1: 'Not recorded', J2: 'Upper arm tilts forward', J3: 'Forearm raises the gripper', J4: 'Jaws open' },
  limitSource: { J1: 'Tested by hand 2026-11-06, judged by eye: the base turns 0–180°; 10–170° keeps a margin', J2: 'Tested by hand 2026-11-02 and 2026-11-06, judged by eye: about 120° is the lowest with the forearm at 95° or above; 115° with the forearm at 100° hits the forearm; 180° is fine with the forearm at 100°', J3: 'Tested by hand 2026-11-06, judged by eye: about 68° is the lowest with the upper arm at 140°. The 150° maximum is from the original ESP32 firmware; 145° was reached with the upper arm at 145°', J4: 'Observed: 98° is the lowest angle that closes without buzzing; 170° is open' },
  originalFirmwareHome: { J1: 90, J2: 140, J3: 90, J4: 0 },
  notes: [
    'Upper arm and forearm limit each other. The lowest safe forearm angle is about 95° with the upper arm at 120° and about 68° with the upper arm at 140°. Only those two points were tested: the line between them is an estimate, and above 140° the upper arm was not checked at low forearm angles, so the 68° floor there is untested. The Debug, Show, Pick, Pick_Rough and OneByOne sketches use forearm >= 98 - 1.35 × (upper arm - 120) with a floor of 68°, a 3° margin on that line; Debug skips the check under free 1 and assumes the worst case for an arm with no angle yet. Arduino_Uno_Arm_Test and Arduino_Uno_Arm_Reach_Alone do not have this rule.',
    'Gripper: at 95° and below the jaws clamp and the servo buzzes (stall). 170° is open; 180° looks about the same as 170°. The original firmware used 0–80° for the gripper, and 0° stalls it.',
    'The sketch makes servo pulses with Timer1 compare interrupts (no Servo library), mapping 0–180° to 500–2500 µs, the same map as the ESP32 firmware.',
    'Reach / retract copies the original firmware robot_add / robot_back. robot_back uses strict comparisons, so the shoulder does not follow on the step where the forearm lands exactly on 90°: one reach-and-retract across 90° leaves the shoulder 3° higher. The V4 full sequence starts the forearm at 100° and does not cross 90°.',
    'The V4 full sequence (A) ran on 2026-10-30 without a board reset and returned to 90/145/100/98. The owner said reach / retract was "slightly off" without saying how.',
  ],
};
/** A copy for a task's own servoCalibration, so later setup edits never change the record. */
export const recordedUnoCalibration = (): ServoLimits => structuredClone(UNO_ARM_CALIBRATION);
export function usesRecordedUnoCalibration(limits: ServoLimits) {
  return JOINT_IDS.every(joint => {
    const value = limits[joint], recorded = UNO_ARM_CALIBRATION[joint]!;
    return !!value && value.min === recorded.min && value.max === recorded.max && value.zero === recorded.zero && value.direction === recorded.direction;
  });
}
export function pinPlaceholder(controller: string) {
  if (/^arduino/i.test(controller)) return 'e.g. D9';
  if (/^stm32/i.test(controller)) return 'e.g. PA8';
  if (/esp32/i.test(controller)) return 'e.g. GPIO 18';
  return 'e.g. D9 or GPIO 18';
}
export function hardwareDescription(controller = 'ESP32') {
  const measuredArm = controller === 'Arduino Uno' ? MEASURED_UNO_ARM : undefined;
  return {
    profile: HARDWARE_PROFILE, controller, controllerProfile: CONTROLLER_PROFILES[controller], measuredArm, servo: 'SG90', servoCount: 4,
    armDOF: 3, gripperDOF: 1, independentWrist: false,
    axes: JOINTS, servoCalibration: pendingCalibration(),
    specification: { homeSizeCm: [18,9.5,18], maximumExtendedLengthCm: 25, weightG: 160, clawOpeningClaimDeg: 180 },
    calibrationNote: measuredArm
      ? 'measuredArm records the owner\'s arm on the Uno sketch ARDUINO_UNO_ARM_V4 (2026-10-30, joint limits updated 2026-11-06): home angles, joint limits and what a larger angle does (not recorded for the base) were judged by eye, not measured with an instrument; limitSource says where each limit came from. servoCalibration holds only limits entered in setup. The claw opening claim is not a servo travel calibration. Preview proportions and poses are illustrative.'
      : 'Per-servo min/max, zero and direction were not supplied for this controller. Angles recorded on the Arduino Uno sketch do not carry over to other firmware. The claw opening claim is not a servo travel calibration. Preview proportions and poses are illustrative.',
  };
}
