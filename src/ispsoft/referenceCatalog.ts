export interface DeltaInstructionSpec {
  mnemonic: string;
  api_num: number | null;
  category:
    | 'basic_contact'
    | 'basic_coil'
    | 'stack'
    | 'comparison'
    | 'data_transfer'
    | 'arithmetic'
    | 'bitwise_shift'
    | 'floating_point'
    | 'conversion'
    | 'program_flow'
    | 'timer_counter'
    | 'io_special_module'
    | 'communication'
    | 'pid_process'
    | 'high_speed_motion'
    | 'rtc_clock'
    | 'data_processing';
  operands: string[];
  supports_32bit: boolean;
  supports_pulse: boolean;
  series: ('DVP' | 'AS' | 'AH')[];
  description: string;
  example: string;
}

export interface DeltaSpecialDeviceSpec {
  device: string;
  series: 'DVP' | 'AS';
  data_type: 'BOOL' | 'WORD' | 'INT' | 'DWORD';
  access: 'R' | 'R/W';
  category: string;
  description: string;
}

export interface DeltaCrRegisterSpec {
  cr: number;
  name: string;
  access: 'R' | 'R/W';
  default_value: number;
  description: string;
}

export interface DeltaExtensionModuleSpec {
  model: string;
  series: 'DVP' | 'AS';
  kind: 'digital_in' | 'digital_out' | 'digital_io' | 'analog_in' | 'analog_out' | 'analog_mixed' | 'temperature' | 'communication' | 'motion';
  x_points: number;
  y_points: number;
  channels: number;
  description: string;
  cr_map: DeltaCrRegisterSpec[];
}

export const DELTA_INSTRUCTION_CATALOG: DeltaInstructionSpec[] = [
  // Basic contacts & coils
  { mnemonic: 'LD', api_num: null, category: 'basic_contact', operands: ['bit'], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'Load normally open contact onto logic stack', example: 'LD X0' },
  { mnemonic: 'LDI', api_num: null, category: 'basic_contact', operands: ['bit'], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'Load normally closed contact onto logic stack', example: 'LDI X1' },
  { mnemonic: 'LDP', api_num: null, category: 'basic_contact', operands: ['bit'], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'Load rising-edge pulse contact', example: 'LDP M0' },
  { mnemonic: 'LDF', api_num: null, category: 'basic_contact', operands: ['bit'], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'Load falling-edge pulse contact', example: 'LDF M0' },
  { mnemonic: 'AND', api_num: null, category: 'basic_contact', operands: ['bit'], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'Series AND normally open contact', example: 'AND M1' },
  { mnemonic: 'ANI', api_num: null, category: 'basic_contact', operands: ['bit'], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'Series AND normally closed contact', example: 'ANI X2' },
  { mnemonic: 'ANDP', api_num: null, category: 'basic_contact', operands: ['bit'], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'Series AND rising-edge contact', example: 'ANDP X0' },
  { mnemonic: 'ANDF', api_num: null, category: 'basic_contact', operands: ['bit'], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'Series AND falling-edge contact', example: 'ANDF X0' },
  { mnemonic: 'OR', api_num: null, category: 'basic_contact', operands: ['bit'], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'Parallel OR normally open contact', example: 'OR Y0' },
  { mnemonic: 'ORI', api_num: null, category: 'basic_contact', operands: ['bit'], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'Parallel OR normally closed contact', example: 'ORI M10' },
  { mnemonic: 'ORP', api_num: null, category: 'basic_contact', operands: ['bit'], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'Parallel OR rising-edge contact', example: 'ORP X3' },
  { mnemonic: 'ORF', api_num: null, category: 'basic_contact', operands: ['bit'], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'Parallel OR falling-edge contact', example: 'ORF X3' },
  { mnemonic: 'ANB', api_num: null, category: 'stack', operands: [], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'AND top two contact blocks on stack', example: 'ANB' },
  { mnemonic: 'ORB', api_num: null, category: 'stack', operands: [], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'OR top two contact blocks on stack', example: 'ORB' },
  { mnemonic: 'MPS', api_num: null, category: 'stack', operands: [], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'Push current branch result onto branch stack', example: 'MPS' },
  { mnemonic: 'MRD', api_num: null, category: 'stack', operands: [], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'Read top of branch stack without popping', example: 'MRD' },
  { mnemonic: 'MPP', api_num: null, category: 'stack', operands: [], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'Pop top of branch stack', example: 'MPP' },
  { mnemonic: 'INV', api_num: null, category: 'stack', operands: [], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'Invert current logic power-flow result', example: 'INV' },
  { mnemonic: 'OUT', api_num: null, category: 'basic_coil', operands: ['bit'], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'Drive output coil according to rung power', example: 'OUT Y0' },
  { mnemonic: 'SET', api_num: null, category: 'basic_coil', operands: ['bit'], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'Latch bit coil ON when rung power is TRUE', example: 'SET M0' },
  { mnemonic: 'RST', api_num: null, category: 'basic_coil', operands: ['bit_or_word'], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'Reset bit coil, timer, counter, or register to 0', example: 'RST T0' },
  { mnemonic: 'PLS', api_num: 260, category: 'basic_coil', operands: ['bit'], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'One-scan rising-edge pulse output coil', example: 'PLS M100' },
  { mnemonic: 'PLF', api_num: 261, category: 'basic_coil', operands: ['bit'], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'One-scan falling-edge pulse output coil', example: 'PLF M101' },
  // Inline comparison contacts
  { mnemonic: 'LD=', api_num: 224, category: 'comparison', operands: ['S1', 'S2'], supports_32bit: true, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'Load inline comparison S1 = S2 (also LD<>, LD>, LD>=, LD<, LD<=, AND*, OR*, D-prefixed)', example: 'LD= D0 K100' },
  { mnemonic: 'CMP', api_num: 10, category: 'comparison', operands: ['S1', 'S2', 'D'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Compare S1 and S2; sets D (S1>S2), D+1 (S1=S2), D+2 (S1<S2)', example: 'CMP D0 K50 M10' },
  { mnemonic: 'ZCP', api_num: 11, category: 'comparison', operands: ['S1', 'S2', 'S', 'D'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Zone compare S against [S1..S2]; sets D (<S1), D+1 (in range), D+2 (>S2)', example: 'ZCP K10 K50 D0 M20' },
  // Data transfer
  { mnemonic: 'MOV', api_num: 12, category: 'data_transfer', operands: ['S', 'D'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Move 16-bit (or 32-bit DMOV) value S to D', example: 'MOV K100 D0' },
  { mnemonic: 'BMOV', api_num: 15, category: 'data_transfer', operands: ['S', 'D', 'n'], supports_32bit: false, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Block move n words from S..S+n-1 to D..D+n-1', example: 'BMOV D0 D100 K10' },
  { mnemonic: 'FMOV', api_num: 16, category: 'data_transfer', operands: ['S', 'D', 'n'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Fill n consecutive words starting at D with value S', example: 'FMOV K0 D100 K16' },
  { mnemonic: 'XCH', api_num: 17, category: 'data_transfer', operands: ['D1', 'D2'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Exchange contents of D1 and D2', example: 'XCH D0 D1' },
  { mnemonic: 'SWAP', api_num: 147, category: 'data_transfer', operands: ['D'], supports_32bit: false, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Swap high byte and low byte of 16-bit register D', example: 'SWAP D0' },
  { mnemonic: 'ZRST', api_num: 40, category: 'data_transfer', operands: ['D1', 'D2'], supports_32bit: false, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Zone reset all bits or registers from D1 through D2 inclusive', example: 'ZRST M0 M31' },
  // Arithmetic
  { mnemonic: 'ADD', api_num: 20, category: 'arithmetic', operands: ['S1', 'S2', 'D'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Signed integer addition D = S1 + S2', example: 'ADD D0 D1 D2' },
  { mnemonic: 'SUB', api_num: 21, category: 'arithmetic', operands: ['S1', 'S2', 'D'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Signed integer subtraction D = S1 - S2', example: 'SUB D0 D1 D2' },
  { mnemonic: 'MUL', api_num: 22, category: 'arithmetic', operands: ['S1', 'S2', 'D'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Signed multiplication (16x16->32-bit in D,D+1)', example: 'MUL D0 D1 D2' },
  { mnemonic: 'DIV', api_num: 23, category: 'arithmetic', operands: ['S1', 'S2', 'D'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Signed division: quotient -> D, remainder -> D+1', example: 'DIV D0 K10 D2' },
  { mnemonic: 'INC', api_num: 24, category: 'arithmetic', operands: ['D'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Increment register D by 1', example: 'INC D0' },
  { mnemonic: 'DEC', api_num: 25, category: 'arithmetic', operands: ['D'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Decrement register D by 1', example: 'DEC D0' },
  { mnemonic: 'NEG', api_num: 29, category: 'arithmetic', operands: ['D'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Two-complement negation D = -D', example: 'NEG D0' },
  { mnemonic: 'SQR', api_num: 48, category: 'arithmetic', operands: ['S', 'D'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Integer square root D = floor(sqrt(S))', example: 'SQR D0 D2' },
  // Bitwise & Shift/Rotate
  { mnemonic: 'ANDW', api_num: 26, category: 'bitwise_shift', operands: ['S1', 'S2', 'D'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Bitwise AND of words D = S1 & S2', example: 'ANDW D0 H00FF D1' },
  { mnemonic: 'ORW', api_num: 27, category: 'bitwise_shift', operands: ['S1', 'S2', 'D'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Bitwise OR of words D = S1 | S2', example: 'ORW D0 H0001 D1' },
  { mnemonic: 'XORW', api_num: 28, category: 'bitwise_shift', operands: ['S1', 'S2', 'D'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Bitwise XOR of words D = S1 ^ S2', example: 'XORW D0 HFFFF D1' },
  { mnemonic: 'ROL', api_num: 31, category: 'bitwise_shift', operands: ['D', 'n'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Rotate left register D by n bits', example: 'ROL D0 K1' },
  { mnemonic: 'ROR', api_num: 30, category: 'bitwise_shift', operands: ['D', 'n'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Rotate right register D by n bits', example: 'ROR D0 K1' },
  { mnemonic: 'SHL', api_num: 33, category: 'bitwise_shift', operands: ['D', 'n'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Logical shift left register D by n bits', example: 'SHL D0 K2' },
  { mnemonic: 'SHR', api_num: 32, category: 'bitwise_shift', operands: ['D', 'n'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Logical shift right register D by n bits', example: 'SHR D0 K2' },
  { mnemonic: 'SFTL', api_num: 35, category: 'bitwise_shift', operands: ['S', 'D', 'n1', 'n2'], supports_32bit: false, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Bit shift left: shifts n1 bits at D left by n2, loading n2 bits from S', example: 'SFTL X0 M0 K16 K1' },
  { mnemonic: 'SFTR', api_num: 34, category: 'bitwise_shift', operands: ['S', 'D', 'n1', 'n2'], supports_32bit: false, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Bit shift right: shifts n1 bits at D right by n2, loading n2 bits from S', example: 'SFTR X0 M0 K16 K1' },
  { mnemonic: 'DECO', api_num: 41, category: 'bitwise_shift', operands: ['S', 'D', 'n'], supports_32bit: false, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Decode lower n bits of S to set 1 of 2^n bits at D', example: 'DECO D0 M100 K3' },
  { mnemonic: 'ENCO', api_num: 42, category: 'bitwise_shift', operands: ['S', 'D', 'n'], supports_32bit: false, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Encode highest active bit among 2^n bits at S into D', example: 'ENCO M100 D0 K3' },
  { mnemonic: 'SUM', api_num: 43, category: 'bitwise_shift', operands: ['S', 'D'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Count number of 1-bits (population count) in S into D', example: 'SUM D0 D1' },
  { mnemonic: 'BON', api_num: 44, category: 'bitwise_shift', operands: ['S', 'D', 'n'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Check bit n of S and write state to bit D', example: 'BON D0 M10 K3' },
  // Conversion & Floating-point
  { mnemonic: 'BCD', api_num: 18, category: 'conversion', operands: ['S', 'D'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Convert binary integer S to BCD in D', example: 'BCD D0 D1' },
  { mnemonic: 'BIN', api_num: 19, category: 'conversion', operands: ['S', 'D'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Convert BCD value S to binary integer in D', example: 'BIN D0 D1' },
  { mnemonic: 'FLT', api_num: 49, category: 'floating_point', operands: ['S', 'D'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Convert 16-bit/32-bit integer S to IEEE 754 32-bit float in (D,D+1)', example: 'FLT D0 D10' },
  { mnemonic: 'INT', api_num: 129, category: 'floating_point', operands: ['S', 'D'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Convert IEEE 754 float (S,S+1) to integer in D', example: 'INT D10 D0' },
  { mnemonic: 'EADD', api_num: 120, category: 'floating_point', operands: ['S1', 'S2', 'D'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'IEEE 754 floating-point addition (D,D+1) = S1 + S2', example: 'EADD D10 D12 D14' },
  { mnemonic: 'ESUB', api_num: 121, category: 'floating_point', operands: ['S1', 'S2', 'D'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'IEEE 754 floating-point subtraction (D,D+1) = S1 - S2', example: 'ESUB D10 D12 D14' },
  { mnemonic: 'EMUL', api_num: 122, category: 'floating_point', operands: ['S1', 'S2', 'D'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'IEEE 754 floating-point multiplication (D,D+1) = S1 * S2', example: 'EMUL D10 D12 D14' },
  { mnemonic: 'EDIV', api_num: 123, category: 'floating_point', operands: ['S1', 'S2', 'D'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'IEEE 754 floating-point division (D,D+1) = S1 / S2', example: 'EDIV D10 D12 D14' },
  { mnemonic: 'ESQR', api_num: 127, category: 'floating_point', operands: ['S', 'D'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'IEEE 754 floating-point square root', example: 'ESQR D10 D12' },
  { mnemonic: 'ECMP', api_num: 110, category: 'floating_point', operands: ['S1', 'S2', 'D'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Floating-point compare S1 vs S2 -> D (>), D+1 (=), D+2 (<)', example: 'ECMP D10 D12 M30' },
  { mnemonic: 'EZCP', api_num: 111, category: 'floating_point', operands: ['S1', 'S2', 'S', 'D'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Floating-point zone compare S against [S1..S2]', example: 'EZCP D10 D12 D14 M40' },
  // Data processing & Scaling
  { mnemonic: 'MEAN', api_num: 45, category: 'data_processing', operands: ['S', 'D', 'n'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Compute integer mean of n consecutive registers from S into D', example: 'MEAN D100 D200 K8' },
  { mnemonic: 'SORT', api_num: 69, category: 'data_processing', operands: ['S', 'm1', 'm2', 'D', 'n'], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'Sort table of m1 rows x m2 columns starting at S into D by column n', example: 'SORT D0 K5 K1 D20 K1' },
  { mnemonic: 'SCL', api_num: 256, category: 'data_processing', operands: ['S1', 'S2', 'D'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Linear scaling of input S1 using parameter table at S2 (Xmax,Xmin,Ymax,Ymin) -> D', example: 'SCL D0 D100 D10' },
  { mnemonic: 'SCLP', api_num: 256, category: 'data_processing', operands: ['S1', 'S2', 'D'], supports_32bit: false, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Pulse linear scaling of S1 using parameter table S2 -> D', example: 'SCLP D0 D100 D10' },
  // PID & Process
  { mnemonic: 'PID', api_num: 88, category: 'pid_process', operands: ['S1', 'S2', 'S3', 'D'], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'PID controller: S1=SV, S2=PV, S3=param block (Ts,Kp,Ti,Td,dir,limits), D=MV output', example: 'PID D0 D1 D100 D20' },
  // Timers & Counters
  { mnemonic: 'TMR', api_num: 257, category: 'timer_counter', operands: ['T', 'K'], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'On-delay timer T with setpoint K (100ms/10ms/1ms base depending on T number)', example: 'TMR T0 K50' },
  { mnemonic: 'CNT', api_num: 258, category: 'timer_counter', operands: ['C', 'K'], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: '16-bit up counter C0-C199 with setpoint K', example: 'CNT C0 K10' },
  { mnemonic: 'DCNT', api_num: 259, category: 'timer_counter', operands: ['C', 'K'], supports_32bit: true, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: '32-bit up/down high-speed counter C200-C255', example: 'DCNT C200 K10000' },
  // Special I/O Module BFM
  { mnemonic: 'FROM', api_num: 78, category: 'io_special_module', operands: ['m1', 'm2', 'D', 'n'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Read n words from special extension module m1 starting at CR# m2 into D', example: 'FROM K0 K6 D100 K4' },
  { mnemonic: 'TO', api_num: 79, category: 'io_special_module', operands: ['m1', 'm2', 'S', 'n'], supports_32bit: true, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Write n words from S into special extension module m1 starting at CR# m2', example: 'TO K0 K1 D200 K1' },
  // Communication
  { mnemonic: 'MODRD', api_num: 100, category: 'communication', operands: ['S1', 'S2', 'n'], supports_32bit: false, supports_pulse: false, series: ['DVP'], description: 'Modbus RTU master read n registers from slave S1 at address S2 (result in D1070+)', example: 'MODRD K1 H2100 K2' },
  { mnemonic: 'MODWR', api_num: 101, category: 'communication', operands: ['S1', 'S2', 'n'], supports_32bit: false, supports_pulse: false, series: ['DVP'], description: 'Modbus RTU master write value n to slave S1 at address S2', example: 'MODWR K1 H2000 K1' },
  { mnemonic: 'MODRW', api_num: 150, category: 'communication', operands: ['S1', 'S2', 'S3', 'S', 'n'], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS'], description: 'General Modbus RTU read/write: slave S1, FC S2, addr S3, buffer S, count n', example: 'MODRW K1 H03 H0000 D100 K4' },
  // High-speed & Motion
  { mnemonic: 'SPD', api_num: 56, category: 'high_speed_motion', operands: ['S1', 'S2', 'D'], supports_32bit: true, supports_pulse: false, series: ['DVP', 'AS'], description: 'Pulse speed density detection on input S1 over window S2 ms -> D', example: 'SPD X0 K100 D0' },
  { mnemonic: 'PLSY', api_num: 57, category: 'high_speed_motion', operands: ['S1', 'S2', 'D'], supports_32bit: true, supports_pulse: false, series: ['DVP', 'AS'], description: 'Output S2 pulses at frequency S1 Hz on transistor output D (Y0/Y2)', example: 'PLSY K1000 K5000 Y0' },
  { mnemonic: 'PWM', api_num: 58, category: 'high_speed_motion', operands: ['S1', 'S2', 'D'], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS'], description: 'Pulse-width modulation: pulse width S1, period S2 on output D', example: 'PWM D0 K100 Y0' },
  { mnemonic: 'PLSR', api_num: 59, category: 'high_speed_motion', operands: ['S1', 'S2', 'S3', 'D'], supports_32bit: true, supports_pulse: false, series: ['DVP', 'AS'], description: 'Trapezoidal accel/decel pulse output: max freq S1, pulses S2, accel ms S3, out D', example: 'PLSR K5000 K10000 K200 Y0' },
  { mnemonic: 'ZRN', api_num: 156, category: 'high_speed_motion', operands: ['S1', 'S2', 'S3', 'D'], supports_32bit: true, supports_pulse: false, series: ['DVP', 'AS'], description: 'Zero return (homing): fast freq S1, creep freq S2, DOG input S3, pulse out D', example: 'ZRN K2000 K200 X4 Y0' },
  { mnemonic: 'DDRVI', api_num: 158, category: 'high_speed_motion', operands: ['S1', 'S2', 'D1', 'D2'], supports_32bit: true, supports_pulse: false, series: ['DVP', 'AS'], description: '32-bit relative positioning: pulses S1, freq S2, pulse out D1, dir out D2', example: 'DDRVI K5000 K2000 Y0 Y1' },
  { mnemonic: 'DDRVA', api_num: 159, category: 'high_speed_motion', operands: ['S1', 'S2', 'D1', 'D2'], supports_32bit: true, supports_pulse: false, series: ['DVP', 'AS'], description: '32-bit absolute positioning: target S1, freq S2, pulse out D1, dir out D2', example: 'DDRVA K10000 K2000 Y0 Y1' },
  // RTC Clock
  { mnemonic: 'TRD', api_num: 166, category: 'rtc_clock', operands: ['D'], supports_32bit: false, supports_pulse: true, series: ['DVP', 'AS'], description: 'Read PLC real-time clock (Year,DayOfWeek,Month,Day,Hour,Min,Sec) into D..D+6', example: 'TRD D200' },
  { mnemonic: 'TWR', api_num: 167, category: 'rtc_clock', operands: ['S'], supports_32bit: false, supports_pulse: true, series: ['DVP', 'AS'], description: 'Write real-time clock from 7-word block S..S+6', example: 'TWR D200' },
  { mnemonic: 'TCMP', api_num: 160, category: 'rtc_clock', operands: ['S1', 'S2', 'S3', 'S', 'D'], supports_32bit: false, supports_pulse: true, series: ['DVP', 'AS'], description: 'Compare target time S1:S2:S3 against RTC block S -> D, D+1, D+2', example: 'TCMP K8 K30 K0 D200 M50' },
  { mnemonic: 'TZCP', api_num: 161, category: 'rtc_clock', operands: ['S1', 'S2', 'S', 'D'], supports_32bit: false, supports_pulse: true, series: ['DVP', 'AS'], description: 'Time zone compare RTC S against [S1..S2] -> D, D+1, D+2', example: 'TZCP D10 D20 D200 M60' },
  // Program Flow
  { mnemonic: 'CJ', api_num: 0, category: 'program_flow', operands: ['P'], supports_32bit: false, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Conditional jump to pointer label P', example: 'CJ P10' },
  { mnemonic: 'CALL', api_num: 1, category: 'program_flow', operands: ['P'], supports_32bit: false, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Call subroutine at pointer label P', example: 'CALL P20' },
  { mnemonic: 'SRET', api_num: 2, category: 'program_flow', operands: [], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'Return from subroutine', example: 'SRET' },
  { mnemonic: 'IRET', api_num: 3, category: 'program_flow', operands: [], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'Return from interrupt service routine', example: 'IRET' },
  { mnemonic: 'EI', api_num: 4, category: 'program_flow', operands: [], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'Enable interrupts', example: 'EI' },
  { mnemonic: 'DI', api_num: 5, category: 'program_flow', operands: [], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'Disable interrupts', example: 'DI' },
  { mnemonic: 'FEND', api_num: 6, category: 'program_flow', operands: [], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'End of main program (subroutines and interrupts follow)', example: 'FEND' },
  { mnemonic: 'WDT', api_num: 7, category: 'program_flow', operands: [], supports_32bit: false, supports_pulse: true, series: ['DVP', 'AS', 'AH'], description: 'Reset CPU watchdog timer during long scan', example: 'WDT' },
  { mnemonic: 'FOR', api_num: 8, category: 'program_flow', operands: ['S'], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'Start loop executing S times until matching NEXT', example: 'FOR K10' },
  { mnemonic: 'NEXT', api_num: 9, category: 'program_flow', operands: [], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'End of FOR loop', example: 'NEXT' },
  { mnemonic: 'MC', api_num: 266, category: 'program_flow', operands: ['N', 'M'], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'Master control zone start (nest level N0..N7, enable bit M)', example: 'MC N0 M0' },
  { mnemonic: 'MCR', api_num: 267, category: 'program_flow', operands: ['N'], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'Master control zone reset (nest level N0..N7)', example: 'MCR N0' },
  { mnemonic: 'STL', api_num: 264, category: 'program_flow', operands: ['S'], supports_32bit: false, supports_pulse: false, series: ['DVP'], description: 'Step Ladder (SFC) step start for state relay S', example: 'STL S0' },
  { mnemonic: 'RET', api_num: 265, category: 'program_flow', operands: [], supports_32bit: false, supports_pulse: false, series: ['DVP'], description: 'End of Step Ladder (STL) block', example: 'RET' },
  { mnemonic: 'NOP', api_num: null, category: 'program_flow', operands: [], supports_32bit: false, supports_pulse: false, series: ['DVP', 'AS', 'AH'], description: 'No operation', example: 'NOP' },
];

export const DELTA_SPECIAL_DEVICES: DeltaSpecialDeviceSpec[] = [
  // DVP Special Auxiliary Relays (M1000+)
  { device: 'M1000', series: 'DVP', data_type: 'BOOL', access: 'R', category: 'system_run', description: 'Normally ON while PLC is in RUN mode (Run Monitor Contact a)' },
  { device: 'M1001', series: 'DVP', data_type: 'BOOL', access: 'R', category: 'system_run', description: 'Normally OFF while PLC is in RUN mode (Run Monitor Contact b)' },
  { device: 'M1002', series: 'DVP', data_type: 'BOOL', access: 'R', category: 'system_run', description: 'First scan pulse ON (TRUE on scan 1 only after STOP->RUN)' },
  { device: 'M1003', series: 'DVP', data_type: 'BOOL', access: 'R', category: 'system_run', description: 'First scan pulse OFF (FALSE on scan 1, TRUE thereafter)' },
  { device: 'M1004', series: 'DVP', data_type: 'BOOL', access: 'R', category: 'error_flag', description: 'ON when PLC syntax/runtime error occurs' },
  { device: 'M1011', series: 'DVP', data_type: 'BOOL', access: 'R', category: 'clock_pulse', description: '10 ms clock pulse (5 ms ON, 5 ms OFF)' },
  { device: 'M1012', series: 'DVP', data_type: 'BOOL', access: 'R', category: 'clock_pulse', description: '100 ms clock pulse (50 ms ON, 50 ms OFF)' },
  { device: 'M1013', series: 'DVP', data_type: 'BOOL', access: 'R', category: 'clock_pulse', description: '1 second clock pulse (0.5 s ON, 0.5 s OFF)' },
  { device: 'M1014', series: 'DVP', data_type: 'BOOL', access: 'R', category: 'clock_pulse', description: '1 minute clock pulse (30 s ON, 30 s OFF)' },
  { device: 'M1015', series: 'DVP', data_type: 'BOOL', access: 'R/W', category: 'timer_mode', description: 'High-speed timer enable' },
  { device: 'M1020', series: 'DVP', data_type: 'BOOL', access: 'R', category: 'alu_flag', description: 'Zero flag (ON when arithmetic result equals 0)' },
  { device: 'M1021', series: 'DVP', data_type: 'BOOL', access: 'R', category: 'alu_flag', description: 'Borrow flag (ON when subtraction underflows)' },
  { device: 'M1022', series: 'DVP', data_type: 'BOOL', access: 'R', category: 'alu_flag', description: 'Carry flag (ON when addition overflows)' },
  { device: 'M1028', series: 'DVP', data_type: 'BOOL', access: 'R/W', category: 'timer_mode', description: '10 ms timer mode select for T64-T126 (ES2/EX2/SS2)' },
  { device: 'M1029', series: 'DVP', data_type: 'BOOL', access: 'R', category: 'motion', description: 'CH0 (Y0/Y1) pulse output execution completed flag' },
  { device: 'M1030', series: 'DVP', data_type: 'BOOL', access: 'R', category: 'motion', description: 'CH1 (Y2/Y3) pulse output execution completed flag' },
  { device: 'M1031', series: 'DVP', data_type: 'BOOL', access: 'R/W', category: 'memory', description: 'Clear all non-latched memory when turned ON' },
  { device: 'M1032', series: 'DVP', data_type: 'BOOL', access: 'R/W', category: 'memory', description: 'Clear all latched memory when turned ON' },
  { device: 'M1033', series: 'DVP', data_type: 'BOOL', access: 'R/W', category: 'system_run', description: 'Retain output states when switching RUN -> STOP' },
  { device: 'M1034', series: 'DVP', data_type: 'BOOL', access: 'R/W', category: 'system_run', description: 'Disable all physical Y outputs when ON' },
  { device: 'M1038', series: 'DVP', data_type: 'BOOL', access: 'R/W', category: 'timer_mode', description: '10 ms timer mode select for T200-T245' },
  { device: 'M1040', series: 'DVP', data_type: 'BOOL', access: 'R/W', category: 'sfc_stl', description: 'Inhibit STL step transition' },
  { device: 'M1067', series: 'DVP', data_type: 'BOOL', access: 'R', category: 'error_flag', description: 'Operation error flag (e.g. divide by zero)' },
  { device: 'M1120', series: 'DVP', data_type: 'BOOL', access: 'R/W', category: 'comm', description: 'Retain COM2 RS-485 communication settings' },
  { device: 'M1122', series: 'DVP', data_type: 'BOOL', access: 'R/W', category: 'comm', description: 'COM2 sending request flag' },
  { device: 'M1123', series: 'DVP', data_type: 'BOOL', access: 'R', category: 'comm', description: 'COM2 receiving completed flag' },
  { device: 'M1127', series: 'DVP', data_type: 'BOOL', access: 'R', category: 'comm', description: 'COM2 MODRD/MODWR/MODRW completed flag' },
  { device: 'M1129', series: 'DVP', data_type: 'BOOL', access: 'R', category: 'comm', description: 'COM2 communication timeout flag' },
  { device: 'M1140', series: 'DVP', data_type: 'BOOL', access: 'R', category: 'comm', description: 'MODRD/MODWR/MODRW data receive error flag' },
  { device: 'M1143', series: 'DVP', data_type: 'BOOL', access: 'R/W', category: 'comm', description: 'COM2 Modbus ASCII (OFF) / RTU (ON) mode select' },
  { device: 'M1350', series: 'DVP', data_type: 'BOOL', access: 'R/W', category: 'plc_link', description: 'Enable PLC Link (RS-485 Data Exchange)' },
  { device: 'M1351', series: 'DVP', data_type: 'BOOL', access: 'R/W', category: 'plc_link', description: 'Enable automatic PLC Link polling' },
  // DVP Special Data Registers (D1000+)
  { device: 'D1000', series: 'DVP', data_type: 'WORD', access: 'R/W', category: 'system_run', description: 'Watchdog timer (WDT) timeout setting in ms (default 200 ms)' },
  { device: 'D1001', series: 'DVP', data_type: 'WORD', access: 'R', category: 'system_info', description: 'PLC firmware version' },
  { device: 'D1004', series: 'DVP', data_type: 'WORD', access: 'R', category: 'error_flag', description: 'Syntax error code' },
  { device: 'D1010', series: 'DVP', data_type: 'WORD', access: 'R', category: 'scan_time', description: 'Current scan time (unit: 0.1 ms)' },
  { device: 'D1011', series: 'DVP', data_type: 'WORD', access: 'R', category: 'scan_time', description: 'Minimum scan time (unit: 0.1 ms)' },
  { device: 'D1012', series: 'DVP', data_type: 'WORD', access: 'R', category: 'scan_time', description: 'Maximum scan time (unit: 0.1 ms)' },
  { device: 'D1013', series: 'DVP', data_type: 'WORD', access: 'R/W', category: 'rtc_clock', description: 'RTC Seconds (0-59)' },
  { device: 'D1014', series: 'DVP', data_type: 'WORD', access: 'R/W', category: 'rtc_clock', description: 'RTC Minutes (0-59)' },
  { device: 'D1015', series: 'DVP', data_type: 'WORD', access: 'R/W', category: 'rtc_clock', description: 'RTC Hours (0-23)' },
  { device: 'D1016', series: 'DVP', data_type: 'WORD', access: 'R/W', category: 'rtc_clock', description: 'RTC Day of Month (1-31)' },
  { device: 'D1017', series: 'DVP', data_type: 'WORD', access: 'R/W', category: 'rtc_clock', description: 'RTC Month (1-12)' },
  { device: 'D1018', series: 'DVP', data_type: 'WORD', access: 'R/W', category: 'rtc_clock', description: 'RTC Day of Week (1-7)' },
  { device: 'D1019', series: 'DVP', data_type: 'WORD', access: 'R/W', category: 'rtc_clock', description: 'RTC Year (00-99)' },
  { device: 'D1020', series: 'DVP', data_type: 'WORD', access: 'R/W', category: 'io_filter', description: 'Input digital filter time for X0-X7 (ms)' },
  { device: 'D1021', series: 'DVP', data_type: 'WORD', access: 'R/W', category: 'io_filter', description: 'Input digital filter time for X10-X17 (ms)' },
  { device: 'D1030', series: 'DVP', data_type: 'WORD', access: 'R', category: 'motion', description: 'CH0 (Y0) current pulse position (low 16 bits, D1031 high)' },
  { device: 'D1032', series: 'DVP', data_type: 'WORD', access: 'R', category: 'motion', description: 'CH1 (Y2) current pulse position (low 16 bits, D1033 high)' },
  { device: 'D1067', series: 'DVP', data_type: 'WORD', access: 'R', category: 'error_flag', description: 'Operation error code' },
  { device: 'D1120', series: 'DVP', data_type: 'WORD', access: 'R/W', category: 'comm', description: 'COM2 RS-485 communication format word (baud, data bits, parity, stop bits)' },
  { device: 'D1121', series: 'DVP', data_type: 'WORD', access: 'R/W', category: 'comm', description: 'PLC Modbus slave station address (1-254)' },
  { device: 'D1129', series: 'DVP', data_type: 'WORD', access: 'R/W', category: 'comm', description: 'COM2 communication timeout setting (ms)' },
  { device: 'D1220', series: 'DVP', data_type: 'WORD', access: 'R', category: 'io_special_module', description: 'Number of connected right-side special extension modules' },
  // AS-Series Special Relays & Registers (SM / SR)
  { device: 'SM0', series: 'AS', data_type: 'BOOL', access: 'R', category: 'system_run', description: 'AS-series PLC RUN indicator' },
  { device: 'SM400', series: 'AS', data_type: 'BOOL', access: 'R', category: 'system_run', description: 'AS-series Always ON relay' },
  { device: 'SM401', series: 'AS', data_type: 'BOOL', access: 'R', category: 'system_run', description: 'AS-series Always OFF relay' },
  { device: 'SM402', series: 'AS', data_type: 'BOOL', access: 'R', category: 'system_run', description: 'AS-series First scan pulse ON' },
  { device: 'SM403', series: 'AS', data_type: 'BOOL', access: 'R', category: 'system_run', description: 'AS-series First scan pulse OFF' },
  { device: 'SM409', series: 'AS', data_type: 'BOOL', access: 'R', category: 'clock_pulse', description: 'AS-series 10 ms clock pulse' },
  { device: 'SM410', series: 'AS', data_type: 'BOOL', access: 'R', category: 'clock_pulse', description: 'AS-series 100 ms clock pulse' },
  { device: 'SM412', series: 'AS', data_type: 'BOOL', access: 'R', category: 'clock_pulse', description: 'AS-series 1 second clock pulse' },
  { device: 'SM414', series: 'AS', data_type: 'BOOL', access: 'R', category: 'clock_pulse', description: 'AS-series 1 minute clock pulse' },
  { device: 'SM600', series: 'AS', data_type: 'BOOL', access: 'R', category: 'alu_flag', description: 'AS-series Zero flag' },
  { device: 'SM601', series: 'AS', data_type: 'BOOL', access: 'R', category: 'alu_flag', description: 'AS-series Borrow flag' },
  { device: 'SM602', series: 'AS', data_type: 'BOOL', access: 'R', category: 'alu_flag', description: 'AS-series Carry flag' },
  { device: 'SR0', series: 'AS', data_type: 'WORD', access: 'R', category: 'error_flag', description: 'AS-series CPU error code' },
  { device: 'SR410', series: 'AS', data_type: 'WORD', access: 'R', category: 'scan_time', description: 'AS-series current scan time (0.1 ms)' },
  { device: 'SR411', series: 'AS', data_type: 'WORD', access: 'R', category: 'scan_time', description: 'AS-series minimum scan time (0.1 ms)' },
  { device: 'SR412', series: 'AS', data_type: 'WORD', access: 'R', category: 'scan_time', description: 'AS-series maximum scan time (0.1 ms)' },
  { device: 'SR460', series: 'AS', data_type: 'WORD', access: 'R/W', category: 'rtc_clock', description: 'AS-series RTC Year (4-digit)' },
  { device: 'SR461', series: 'AS', data_type: 'WORD', access: 'R/W', category: 'rtc_clock', description: 'AS-series RTC Month (1-12)' },
  { device: 'SR462', series: 'AS', data_type: 'WORD', access: 'R/W', category: 'rtc_clock', description: 'AS-series RTC Day (1-31)' },
  { device: 'SR463', series: 'AS', data_type: 'WORD', access: 'R/W', category: 'rtc_clock', description: 'AS-series RTC Hour (0-23)' },
  { device: 'SR464', series: 'AS', data_type: 'WORD', access: 'R/W', category: 'rtc_clock', description: 'AS-series RTC Minute (0-59)' },
  { device: 'SR465', series: 'AS', data_type: 'WORD', access: 'R/W', category: 'rtc_clock', description: 'AS-series RTC Second (0-59)' },
];

export const DELTA_EXTENSION_MODULES: DeltaExtensionModuleSpec[] = [
  // DVP Digital I/O
  { model: 'DVP08XM211N', series: 'DVP', kind: 'digital_in', x_points: 8, y_points: 0, channels: 8, description: '8-point digital input extension module', cr_map: [] },
  { model: 'DVP16XM211N', series: 'DVP', kind: 'digital_in', x_points: 16, y_points: 0, channels: 16, description: '16-point digital input extension module', cr_map: [] },
  { model: 'DVP08XP211R', series: 'DVP', kind: 'digital_io', x_points: 4, y_points: 4, channels: 8, description: '4 DI / 4 DO relay extension module', cr_map: [] },
  { model: 'DVP16SP11R', series: 'DVP', kind: 'digital_io', x_points: 8, y_points: 8, channels: 16, description: '8 DI / 8 DO relay extension module', cr_map: [] },
  { model: 'DVP16SP11T', series: 'DVP', kind: 'digital_io', x_points: 8, y_points: 8, channels: 16, description: '8 DI / 8 DO transistor extension module', cr_map: [] },
  { model: 'DVP16XP211T', series: 'DVP', kind: 'digital_io', x_points: 8, y_points: 8, channels: 16, description: 'ES2 8 DI / 8 DO transistor extension module', cr_map: [] },
  { model: 'DVP08XN211R', series: 'DVP', kind: 'digital_out', x_points: 0, y_points: 8, channels: 8, description: '8-point relay output extension module', cr_map: [] },
  { model: 'DVP16XN211T', series: 'DVP', kind: 'digital_out', x_points: 0, y_points: 16, channels: 16, description: '16-point transistor output extension module', cr_map: [] },
  // DVP Analog & Temperature Special Modules
  {
    model: 'DVP04AD-E2',
    series: 'DVP',
    kind: 'analog_in',
    x_points: 0,
    y_points: 0,
    channels: 4,
    description: '4-channel 14-bit analog input module (-10..+10V or -20..+20mA)',
    cr_map: [
      { cr: 0, name: 'MODEL_CODE', access: 'R', default_value: 0x0104, description: 'Module ID code (0x0104)' },
      { cr: 1, name: 'CH1_CH4_MODE', access: 'R/W', default_value: 0x0000, description: 'Input mode per channel (0=±10V, 1=0..10V, 2=±20mA, 3=4..20mA)' },
      { cr: 2, name: 'CH1_AVG_SAMPLES', access: 'R/W', default_value: 10, description: 'CH1 averaging sample count (1..100)' },
      { cr: 3, name: 'CH2_AVG_SAMPLES', access: 'R/W', default_value: 10, description: 'CH2 averaging sample count (1..100)' },
      { cr: 4, name: 'CH3_AVG_SAMPLES', access: 'R/W', default_value: 10, description: 'CH3 averaging sample count (1..100)' },
      { cr: 5, name: 'CH4_AVG_SAMPLES', access: 'R/W', default_value: 10, description: 'CH4 averaging sample count (1..100)' },
      { cr: 6, name: 'CH1_AVG_VAL', access: 'R', default_value: 0, description: 'CH1 averaged digital value (-2000..+2000 or 0..4000)' },
      { cr: 7, name: 'CH2_AVG_VAL', access: 'R', default_value: 0, description: 'CH2 averaged digital value' },
      { cr: 8, name: 'CH3_AVG_VAL', access: 'R', default_value: 0, description: 'CH3 averaged digital value' },
      { cr: 9, name: 'CH4_AVG_VAL', access: 'R', default_value: 0, description: 'CH4 averaged digital value' },
      { cr: 12, name: 'CH1_PRESENT_VAL', access: 'R', default_value: 0, description: 'CH1 instantaneous raw value' },
      { cr: 13, name: 'CH2_PRESENT_VAL', access: 'R', default_value: 0, description: 'CH2 instantaneous raw value' },
      { cr: 14, name: 'CH3_PRESENT_VAL', access: 'R', default_value: 0, description: 'CH3 instantaneous raw value' },
      { cr: 15, name: 'CH4_PRESENT_VAL', access: 'R', default_value: 0, description: 'CH4 instantaneous raw value' },
      { cr: 30, name: 'ERROR_STATUS', access: 'R', default_value: 0, description: 'Error bitmask (0 = OK)' },
    ],
  },
  {
    model: 'DVP04DA-E2',
    series: 'DVP',
    kind: 'analog_out',
    x_points: 0,
    y_points: 0,
    channels: 4,
    description: '4-channel 12-bit analog output module (0..10V or 4..20mA)',
    cr_map: [
      { cr: 0, name: 'MODEL_CODE', access: 'R', default_value: 0x0204, description: 'Module ID code (0x0204)' },
      { cr: 1, name: 'CH1_CH4_MODE', access: 'R/W', default_value: 0x0000, description: 'Output mode per channel (0=0..10V, 1=0..20mA, 2=4..20mA)' },
      { cr: 6, name: 'CH1_OUTPUT_VAL', access: 'R/W', default_value: 0, description: 'CH1 DAC output register (0..4000)' },
      { cr: 7, name: 'CH2_OUTPUT_VAL', access: 'R/W', default_value: 0, description: 'CH2 DAC output register (0..4000)' },
      { cr: 8, name: 'CH3_OUTPUT_VAL', access: 'R/W', default_value: 0, description: 'CH3 DAC output register (0..4000)' },
      { cr: 9, name: 'CH4_OUTPUT_VAL', access: 'R/W', default_value: 0, description: 'CH4 DAC output register (0..4000)' },
      { cr: 30, name: 'ERROR_STATUS', access: 'R', default_value: 0, description: 'Error bitmask (0 = OK)' },
    ],
  },
  {
    model: 'DVP06XA-E2',
    series: 'DVP',
    kind: 'analog_mixed',
    x_points: 0,
    y_points: 0,
    channels: 6,
    description: '4-channel analog input + 2-channel analog output mixed module',
    cr_map: [
      { cr: 0, name: 'MODEL_CODE', access: 'R', default_value: 0x0306, description: 'Module ID code' },
      { cr: 1, name: 'MODE_SELECT', access: 'R/W', default_value: 0, description: 'AD/DA channel mode configuration' },
      { cr: 6, name: 'CH1_AD_VAL', access: 'R', default_value: 0, description: 'AD CH1 averaged value' },
      { cr: 7, name: 'CH2_AD_VAL', access: 'R', default_value: 0, description: 'AD CH2 averaged value' },
      { cr: 8, name: 'CH3_AD_VAL', access: 'R', default_value: 0, description: 'AD CH3 averaged value' },
      { cr: 9, name: 'CH4_AD_VAL', access: 'R', default_value: 0, description: 'AD CH4 averaged value' },
      { cr: 10, name: 'CH5_DA_OUT', access: 'R/W', default_value: 0, description: 'DA CH1 output register (0..4000)' },
      { cr: 11, name: 'CH6_DA_OUT', access: 'R/W', default_value: 0, description: 'DA CH2 output register (0..4000)' },
      { cr: 30, name: 'ERROR_STATUS', access: 'R', default_value: 0, description: 'Error bitmask' },
    ],
  },
  {
    model: 'DVP04PT-E2',
    series: 'DVP',
    kind: 'temperature',
    x_points: 0,
    y_points: 0,
    channels: 4,
    description: '4-channel PT100/PT1000 RTD temperature sensor module (0.1 deg C)',
    cr_map: [
      { cr: 0, name: 'MODEL_CODE', access: 'R', default_value: 0x0404, description: 'Module ID code' },
      { cr: 1, name: 'SENSOR_MODE', access: 'R/W', default_value: 0, description: '0=PT100 Celsius, 1=PT100 Fahrenheit, 2=PT1000 Celsius' },
      { cr: 18, name: 'CH1_TEMP_01C', access: 'R', default_value: 250, description: 'CH1 temperature in 0.1 deg C (e.g. 250 = 25.0 C)' },
      { cr: 19, name: 'CH2_TEMP_01C', access: 'R', default_value: 250, description: 'CH2 temperature in 0.1 deg C' },
      { cr: 20, name: 'CH3_TEMP_01C', access: 'R', default_value: 250, description: 'CH3 temperature in 0.1 deg C' },
      { cr: 21, name: 'CH4_TEMP_01C', access: 'R', default_value: 250, description: 'CH4 temperature in 0.1 deg C' },
      { cr: 30, name: 'ERROR_STATUS', access: 'R', default_value: 0, description: 'Open-wire / range error bitmask' },
    ],
  },
  {
    model: 'DVP04TC-E2',
    series: 'DVP',
    kind: 'temperature',
    x_points: 0,
    y_points: 0,
    channels: 4,
    description: '4-channel thermocouple (J/K/R/S/T) temperature sensor module',
    cr_map: [
      { cr: 0, name: 'MODEL_CODE', access: 'R', default_value: 0x0504, description: 'Module ID code' },
      { cr: 1, name: 'TC_TYPE', access: 'R/W', default_value: 0, description: 'Thermocouple type (0=J, 1=K, 2=R, 3=S, 4=T)' },
      { cr: 18, name: 'CH1_TEMP_01C', access: 'R', default_value: 250, description: 'CH1 temperature in 0.1 deg C' },
      { cr: 19, name: 'CH2_TEMP_01C', access: 'R', default_value: 250, description: 'CH2 temperature in 0.1 deg C' },
      { cr: 20, name: 'CH3_TEMP_01C', access: 'R', default_value: 250, description: 'CH3 temperature in 0.1 deg C' },
      { cr: 21, name: 'CH4_TEMP_01C', access: 'R', default_value: 250, description: 'CH4 temperature in 0.1 deg C' },
      { cr: 30, name: 'ERROR_STATUS', access: 'R', default_value: 0, description: 'Error bitmask' },
    ],
  },
  {
    model: 'DVPEN01-SL',
    series: 'DVP',
    kind: 'communication',
    x_points: 0,
    y_points: 0,
    channels: 1,
    description: 'Ethernet communication module (Modbus TCP server/client, Data Exchange)',
    cr_map: [
      { cr: 0, name: 'MODEL_CODE', access: 'R', default_value: 0x0901, description: 'Ethernet module ID' },
      { cr: 12, name: 'IP_OCTET_1_2', access: 'R/W', default_value: 0xc0a8, description: 'IP address high octets (default 192.168)' },
      { cr: 13, name: 'IP_OCTET_3_4', access: 'R/W', default_value: 0x0105, description: 'IP address low octets (default 1.5)' },
      { cr: 14, name: 'LINK_STATUS', access: 'R', default_value: 1, description: 'Ethernet link up/down status' },
    ],
  },
  // AS-Series Extension Modules
  { model: 'AS16AM10N-A', series: 'AS', kind: 'digital_in', x_points: 16, y_points: 0, channels: 16, description: 'AS-series 16-point 24VDC digital input module', cr_map: [] },
  { model: 'AS16AN01T-A', series: 'AS', kind: 'digital_out', x_points: 0, y_points: 16, channels: 16, description: 'AS-series 16-point transistor output module', cr_map: [] },
  { model: 'AS16AP11R-A', series: 'AS', kind: 'digital_io', x_points: 8, y_points: 8, channels: 16, description: 'AS-series 8 DI / 8 DO relay module', cr_map: [] },
  {
    model: 'AS04AD-A',
    series: 'AS',
    kind: 'analog_in',
    x_points: 0,
    y_points: 0,
    channels: 4,
    description: 'AS-series 4-channel 16-bit analog input module',
    cr_map: [
      { cr: 0, name: 'CH1_RAW', access: 'R', default_value: 0, description: 'CH1 16-bit analog input' },
      { cr: 1, name: 'CH2_RAW', access: 'R', default_value: 0, description: 'CH2 16-bit analog input' },
      { cr: 2, name: 'CH3_RAW', access: 'R', default_value: 0, description: 'CH3 16-bit analog input' },
      { cr: 3, name: 'CH4_RAW', access: 'R', default_value: 0, description: 'CH4 16-bit analog input' },
    ],
  },
  {
    model: 'AS04DA-A',
    series: 'AS',
    kind: 'analog_out',
    x_points: 0,
    y_points: 0,
    channels: 4,
    description: 'AS-series 4-channel 12-bit analog output module',
    cr_map: [
      { cr: 0, name: 'CH1_OUT', access: 'R/W', default_value: 0, description: 'CH1 analog output value' },
      { cr: 1, name: 'CH2_OUT', access: 'R/W', default_value: 0, description: 'CH2 analog output value' },
      { cr: 2, name: 'CH3_OUT', access: 'R/W', default_value: 0, description: 'CH3 analog output value' },
      { cr: 3, name: 'CH4_OUT', access: 'R/W', default_value: 0, description: 'CH4 analog output value' },
    ],
  },
  {
    model: 'AS04RTD-A',
    series: 'AS',
    kind: 'temperature',
    x_points: 0,
    y_points: 0,
    channels: 4,
    description: 'AS-series 4-channel RTD temperature module',
    cr_map: [
      { cr: 0, name: 'CH1_TEMP_01C', access: 'R', default_value: 250, description: 'CH1 RTD temp (0.1 C)' },
      { cr: 1, name: 'CH2_TEMP_01C', access: 'R', default_value: 250, description: 'CH2 RTD temp (0.1 C)' },
      { cr: 2, name: 'CH3_TEMP_01C', access: 'R', default_value: 250, description: 'CH3 RTD temp (0.1 C)' },
      { cr: 3, name: 'CH4_TEMP_01C', access: 'R', default_value: 250, description: 'CH4 RTD temp (0.1 C)' },
    ],
  },
  {
    model: 'AS04TC-A',
    series: 'AS',
    kind: 'temperature',
    x_points: 0,
    y_points: 0,
    channels: 4,
    description: 'AS-series 4-channel thermocouple module',
    cr_map: [
      { cr: 0, name: 'CH1_TEMP_01C', access: 'R', default_value: 250, description: 'CH1 TC temp (0.1 C)' },
      { cr: 1, name: 'CH2_TEMP_01C', access: 'R', default_value: 250, description: 'CH2 TC temp (0.1 C)' },
      { cr: 2, name: 'CH3_TEMP_01C', access: 'R', default_value: 250, description: 'CH3 TC temp (0.1 C)' },
      { cr: 3, name: 'CH4_TEMP_01C', access: 'R', default_value: 250, description: 'CH4 TC temp (0.1 C)' },
    ],
  },
];

export function findExtensionModuleSpec(model: string): DeltaExtensionModuleSpec | null {
  const norm = model.trim().toUpperCase();
  return DELTA_EXTENSION_MODULES.find((m) => m.model.toUpperCase() === norm) ?? null;
}

export function lookupDeltaReference(options: {
  topic: 'instructions' | 'special_devices' | 'extension_modules' | 'all';
  query?: string;
  series?: 'DVP' | 'AS' | 'AH';
  category?: string;
  limit?: number;
}) {
  const q = (options.query ?? '').trim().toLowerCase();
  const series = options.series;
  const cat = (options.category ?? '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));

  const matchesQuery = (haystack: string) => !q || haystack.toLowerCase().includes(q);

  const instructions =
    options.topic === 'instructions' || options.topic === 'all'
      ? DELTA_INSTRUCTION_CATALOG.filter((item) => {
          if (series && !item.series.includes(series)) return false;
          if (cat && item.category.toLowerCase() !== cat) return false;
          return matchesQuery(`${item.mnemonic} api ${item.api_num ?? ''} ${item.category} ${item.description} ${item.example}`);
        }).slice(0, limit)
      : [];

  const specialDevices =
    options.topic === 'special_devices' || options.topic === 'all'
      ? DELTA_SPECIAL_DEVICES.filter((item) => {
          if (series && series !== 'AH' && item.series !== series) return false;
          if (cat && item.category.toLowerCase() !== cat) return false;
          return matchesQuery(`${item.device} ${item.series} ${item.category} ${item.description}`);
        }).slice(0, limit)
      : [];

  const extensionModules =
    options.topic === 'extension_modules' || options.topic === 'all'
      ? DELTA_EXTENSION_MODULES.filter((item) => {
          if (series && series !== 'AH' && item.series !== series) return false;
          if (cat && item.kind.toLowerCase() !== cat) return false;
          return matchesQuery(
            `${item.model} ${item.series} ${item.kind} ${item.description} ${item.cr_map.map((c) => `${c.name} CR${c.cr}`).join(' ')}`,
          );
        }).slice(0, limit)
      : [];

  return {
    topic: options.topic,
    query: options.query ?? null,
    series: series ?? null,
    counts: {
      instructions: instructions.length,
      special_devices: specialDevices.length,
      extension_modules: extensionModules.length,
    },
    instructions,
    special_devices: specialDevices,
    extension_modules: extensionModules,
  };
}
