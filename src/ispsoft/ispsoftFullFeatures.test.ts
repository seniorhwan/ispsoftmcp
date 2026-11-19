import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeMcpTool } from './tools.js';
import { handleSingleRpc } from './mcpServer.js';
import { resetWorkspaceMemoryCacheForTests, seedDefaultWorkspace } from './workspace.js';

function withIsolatedWorkspace(fn: () => void | Promise<void>) {
  return async () => {
    const prevWorkDir = process.env.ISPSOFT_WORK_DIR;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ispsoft-full-'));
    try {
      process.env.ISPSOFT_WORK_DIR = tmpDir;
      resetWorkspaceMemoryCacheForTests();
      seedDefaultWorkspace();
      await fn();
    } finally {
      resetWorkspaceMemoryCacheForTests();
      if (prevWorkDir === undefined) delete process.env.ISPSOFT_WORK_DIR;
      else process.env.ISPSOFT_WORK_DIR = prevWorkDir;
      seedDefaultWorkspace();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

test(
  'OCC project_content_hash from ispsoft_read_pou matches ispsoft_inspect_project and round-trips on writes',
  withIsolatedWorkspace(() => {
    const insp = executeMcpTool('ispsoft_inspect_project', { project_path: '/workspace/sample_es2.isp' });
    const pou = executeMcpTool('ispsoft_read_pou', { project_path: '/workspace/sample_es2.isp', pou_name: 'Prog0' });
    assert.equal(insp.success, true);
    assert.equal(pou.success, true);
    assert.equal(pou.project_content_hash, insp.content_hash);
    assert.equal(pou.language_name, 'LD');

    // Using project_content_hash for OCC edit succeeds cleanly
    const edit = executeMcpTool('ispsoft_edit_project_properties', {
      project_path: '/workspace/sample_es2.isp',
      properties: { Prj_Comment: 'Regex+Safe.[Test]' },
      expected_content_hash: pou.project_content_hash,
      dry_run: true,
    });
    assert.equal(edit.success, true, JSON.stringify(edit));
  }),
);

test(
  'SFC (P_Lang=4) authoring, static check, ASCII render, and Soft-PLC simulation with Step.X/Step.T & action qualifiers',
  withIsolatedWorkspace(() => {
    const created = executeMcpTool('ispsoft_create_blank_project', {
      model: 'AS228T',
      output_path: '/workspace/sfc_machine.isp',
      initial_pou_name: 'MainSfc',
      language: 'SFC',
    });
    assert.equal(created.success, true, JSON.stringify(created));

    const chart = {
      steps: [
        {
          name: 'Idle',
          initial: true,
          actions: [{ qualifier: 'N', code: 'Y0 := FALSE; D0 := 1;' }],
        },
        {
          name: 'Running',
          actions: [
            { qualifier: 'P1', code: 'D1 := D1 + 1;' },
            { qualifier: 'N', code: 'Y0 := TRUE; D0 := 2;' },
            { qualifier: 'S', name: 'AlarmLatch', code: 'M10 := TRUE;' },
          ],
        },
        {
          name: 'Done',
          actions: [
            { qualifier: 'R', name: 'AlarmLatch', code: 'M10 := FALSE;' },
            { qualifier: 'N', code: 'Y1 := TRUE; D0 := 3;' },
          ],
        },
      ],
      transitions: [
        { name: 'T_Start', from: ['Idle'], to: ['Running'], condition: 'X0', priority: 1 },
        { name: 'T_Complete', from: ['Running'], to: ['Done'], condition: 'Running.T >= 200', priority: 1 },
      ],
    };

    const written = executeMcpTool('ispsoft_write_sfc_pou', {
      project_path: '/workspace/sfc_machine.isp',
      pou_name: 'MainSfc',
      sfc_chart: chart,
      in_place: true,
    });
    assert.equal(written.success, true, JSON.stringify(written));
    assert.ok(String(written.sfc_ascii).includes('[[ Idle (INIT) ]]'));

    const read = executeMcpTool('ispsoft_read_pou', { project_path: '/workspace/sfc_machine.isp', pou_name: 'MainSfc' });
    assert.equal(read.language_name, 'SFC');
    assert.ok(read.sfc_chart);

    const check = executeMcpTool('ispsoft_static_check_and_compile', { project_path: '/workspace/sfc_machine.isp' });
    assert.equal(check.success, true, JSON.stringify(check));

    const sim = executeMcpTool('ispsoft_sim_start', { project_path: '/workspace/sfc_machine.isp', scan_interval_ms: 100 });
    assert.equal(sim.success, true);
    const sid = String(sim.session_id);
    try {
      const seq = executeMcpTool('ispsoft_sim_run_sequence', {
        session_id: sid,
        steps: [
          { label: 'Initial Idle', cycles: 1, expect: { D0: 1, Y0: false } },
          { label: 'Trigger start', force_bits: { X0: true }, cycles: 1, expect: { 'RUNNING.X': true } },
          { label: 'Run step executes P1 once + N + S', cycles: 2, expect: { D0: 2, D1: 1, Y0: true, M10: true } },
          { label: 'Wait until Done', step_until: 'D0 == 3', max_cycles: 10, expect: { D0: 3, Y1: true, M10: false } },
        ],
      });
      assert.equal(seq.success, true, JSON.stringify(seq));
    } finally {
      executeMcpTool('ispsoft_sim_control', { session_id: sid, command: 'CLOSE' });
    }
  }),
);

test(
  'FBD/CFC (P_Lang=5) authoring, topological evaluation, standard IEC FBs (TON/CTU/R_TRIG), and Soft-PLC simulation',
  withIsolatedWorkspace(() => {
    const created = executeMcpTool('ispsoft_create_blank_project', {
      model: 'AS300',
      output_path: '/workspace/fbd_test.isp',
      initial_pou_name: 'MainFbd',
      language: 'FBD',
    });
    assert.equal(created.success, true);

    const diagram = {
      blocks: [
        { id: 'B1', op: 'ADD', inputs: { IN1: 'D0', IN2: 'D1' }, outputs: { OUT: 'D10' } },
        { id: 'B2', op: 'LIMIT', inputs: { MN: '0', IN: 'B1.OUT', MX: '100' }, outputs: { OUT: 'D11' } },
        { id: 'B3', op: 'TON', instance: 'Ton1', inputs: { IN: 'X0', PT: '200' }, outputs: { Q: 'Y0' } },
        { id: 'B4', op: 'R_TRIG', instance: 'Trig1', inputs: { CLK: 'X1' }, outputs: {} },
        { id: 'B5', op: 'CTU', instance: 'Cnt1', inputs: { CU: 'B4.Q', R: 'X2', PV: '2' }, outputs: { Q: 'Y1', CV: 'D12' } },
      ],
    };

    const written = executeMcpTool('ispsoft_write_fbd_pou', {
      project_path: '/workspace/fbd_test.isp',
      pou_name: 'MainFbd',
      fbd_diagram: diagram,
      in_place: true,
    });
    assert.equal(written.success, true, JSON.stringify(written));
    assert.ok(String(written.fbd_ascii).includes('LIMIT'));

    const check = executeMcpTool('ispsoft_static_check_and_compile', { project_path: '/workspace/fbd_test.isp' });
    assert.equal(check.success, true, JSON.stringify(check));

    const sim = executeMcpTool('ispsoft_sim_start', { project_path: '/workspace/fbd_test.isp', scan_interval_ms: 100 });
    const sid = String(sim.session_id);
    try {
      const seq = executeMcpTool('ispsoft_sim_run_sequence', {
        session_id: sid,
        steps: [
          { label: 'Clamp ADD > 100 and start TON + pulse CTU #1', words: { D0: 70, D1: 55 }, force_bits: { X0: true, X1: true }, cycles: 1, expect: { D10: 125, D11: 100, Y0: false, D12: 1, Y1: false } },
          { label: 'Release X1 and advance TON', force_bits: { X1: false }, cycles: 1, expect: { Y0: true, D12: 1 } },
          { label: 'Pulse CTU #2 to reach PV=2', force_bits: { X1: true }, cycles: 1, expect: { D12: 2, Y1: true } },
        ],
      });
      assert.equal(seq.success, true, JSON.stringify(seq));
    } finally {
      executeMcpTool('ispsoft_sim_control', { session_id: sid, command: 'CLOSE' });
    }
  }),
);

test(
  'IL (P_Lang=3) authoring + expanded DVP instructions (INV, pulse P, index V/Z, float, FROM/TO, PID) + HWCONFIG/Retain/DeviceInit/DataExchange + Online Edit + Interrupts + Trace Analytics',
  withIsolatedWorkspace(() => {
    const created = executeMcpTool('ispsoft_create_blank_project', {
      model: 'EH3',
      output_path: '/workspace/hw_il_pid.isp',
      initial_pou_name: 'MainIl',
      language: 'IL',
    });
    assert.equal(created.success, true, JSON.stringify(created));

    // Configure HWCONFIG with DVP04AD-E2 at slot 0 and DVP04DA-E2 at slot 1
    const hw = executeMcpTool('ispsoft_configure_hwconfig', {
      project_path: '/workspace/hw_il_pid.isp',
      hw_config: {
        cpu: { watchdog_ms: 250, constant_scan_ms: 0, retain_outputs_on_stop: false, input_filter_ms: 10, comment: 'Boiler PLC' },
        modules: [
          { slot: 0, model: 'DVP04AD-E2', cr_init: { '6': 1500 } },
          { slot: 1, model: 'DVP04DA-E2' },
        ],
      },
      in_place: true,
    });
    assert.equal(hw.success, true, JSON.stringify(hw));

    // Configure custom retain range: D100-D199 retained, D0-D99 non-retained
    const ret = executeMcpTool('ispsoft_configure_retain_ranges', {
      project_path: '/workspace/hw_il_pid.isp',
      zones: [{ area: 'D', start: 100, end: 199 }],
      in_place: true,
    });
    assert.equal(ret.success, true);

    // Configure Device Initial Values (D10 = 2000 setpoint, D20 = 100 Kp)
    const init = executeMcpTool('ispsoft_configure_device_init', {
      project_path: '/workspace/hw_il_pid.isp',
      entries: [
        { device: 'D10', data_type: 'INT', value: 2000, comment: 'PID Setpoint' },
        { device: 'D20', data_type: 'INT', value: 100, comment: 'PID Ts' },
        { device: 'D21', data_type: 'INT', value: 50, comment: 'PID Kp' },
      ],
      in_place: true,
    });
    assert.equal(init.success, true);

    // Configure Data Exchange table
    const ex = executeMcpTool('ispsoft_configure_data_exchange', {
      project_path: '/workspace/hw_il_pid.isp',
      rows: [
        { index: 0, enabled: true, interface: 'COM2', slave_id: 2, function_code: 3, remote_address: 'D0', local_device: 'D300', length: 4, poll_interval_ms: 100 },
      ],
      in_place: true,
    });
    assert.equal(ex.success, true);

    // Write IL program using FROM/TO, PID, pulse INCP, index register Z0, and INV
    const ilCode = [
      'LD M1000',
      'FROM K0 K6 D50 K1',
      'PID D10 D50 D20 D60',
      'TO K1 K6 D60 K1',
      'LD X0',
      'INCP D100',
      'LD X1',
      'INV',
      'OUT Y0',
      'LD M1000',
      'MOV K2 Z0',
      'MOV K777 D70Z0',
      'END',
    ].join('\n');
    const wIl = executeMcpTool('ispsoft_write_il_pou', {
      project_path: '/workspace/hw_il_pid.isp',
      pou_name: 'MainIl',
      il_code: ilCode,
      in_place: true,
    });
    assert.equal(wIl.success, true, JSON.stringify(wIl));

    // Add an interrupt POU
    const addIsr = executeMcpTool('ispsoft_create_pou', {
      project_path: '/workspace/hw_il_pid.isp',
      pou_name: 'IsrFast',
      language: 'ST',
      pou_type: 'PRG',
      code: 'D150 := D150 + 1;',
      assign_to_task: false,
      in_place: true,
    });
    assert.equal(addIsr.success, true);

    const sim = executeMcpTool('ispsoft_sim_start', { project_path: '/workspace/hw_il_pid.isp', scan_interval_ms: 100 });
    assert.equal(sim.success, true, JSON.stringify(sim));
    const sid = String(sim.session_id);
    try {
      executeMcpTool('ispsoft_sim_watch_table', { session_id: sid, action: 'set', addresses: ['D50', 'D60', 'D100', 'Y0'] });

      // Step 1: FROM reads CR6=1500 into D50, PID computes output > 0 into D60, TO writes slot 1 CR6, INCP increments D100 once, INV(X1=false) -> Y0=true, D70Z0 -> D72=777
      const seq1 = executeMcpTool('ispsoft_sim_run_sequence', {
        session_id: sid,
        steps: [
          { label: 'Scan 1 with X0=true', force_bits: { X0: true }, cycles: 1, expect: { D10: 2000, D50: 1500, D100: 1, Y0: true, D72: 777 } },
          { label: 'Scan 2 with X0 still true (INCP must NOT re-increment)', cycles: 1, expect: { D100: 1 } },
        ],
      });
      assert.equal(seq1.success, true, JSON.stringify(seq1));

      // Verify TO wrote PID output to slot 1 CR6 and inject new analog reading into slot 0 CR6
      const slot1 = executeMcpTool('ispsoft_sim_io_modules', { session_id: sid, action: 'read', slot: 1 });
      assert.equal(slot1.success, true);
      assert.ok(Number((slot1.cr_values as Record<string, number>)['6']) > 0);

      const inject = executeMcpTool('ispsoft_sim_io_modules', { session_id: sid, action: 'write', slot: 0, cr_values: { '6': 1900 } });
      assert.equal(inject.success, true);
      executeMcpTool('ispsoft_sim_control', { session_id: sid, command: 'STEP', cycles: 1 });
      const mon = executeMcpTool('ispsoft_sim_monitor', { session_id: sid, addresses: ['D50', 'D100', 'D72'], compact: true });
      const monVals = mon.queried_addresses as Record<string, { value: unknown }>;
      assert.equal(monVals.D50.value, 1900);

      // Test Retain across WARM_RESET (D100 kept, D72 cleared)
      executeMcpTool('ispsoft_sim_control', { session_id: sid, command: 'WARM_RESET' });
      const afterWarm = executeMcpTool('ispsoft_sim_monitor', { session_id: sid, addresses: ['D100', 'D72'], compact: true });
      const warmVals = afterWarm.queried_addresses as Record<string, { value: unknown }>;
      assert.equal(warmVals.D100.value, 1);
      assert.equal(warmVals.D72.value, 0);

      // Trigger interrupt POU directly
      const isrRes = executeMcpTool('ispsoft_sim_trigger_interrupt', { session_id: sid, pou_name: 'IsrFast' });
      assert.equal(isrRes.success, true, JSON.stringify(isrRes));
      const afterIsr = executeMcpTool('ispsoft_sim_monitor', { session_id: sid, addresses: ['D150'], compact: true });
      assert.equal((afterIsr.queried_addresses as Record<string, { value: unknown }>).D150.value, 1);

      // Online Edit without stopping CPU or losing memory
      const online = executeMcpTool('ispsoft_sim_online_edit', {
        session_id: sid,
        pou_name: 'IsrFast',
        st_code: 'D150 := D150 + 10;',
      });
      assert.equal(online.success, true, JSON.stringify(online));
      executeMcpTool('ispsoft_sim_trigger_interrupt', { session_id: sid, pou_name: 'IsrFast' });
      const afterOnline = executeMcpTool('ispsoft_sim_monitor', { session_id: sid, addresses: ['D150'], compact: true });
      assert.equal((afterOnline.queried_addresses as Record<string, { value: unknown }>).D150.value, 11);

      // Trace analytics & CSV export
      const trace = executeMcpTool('ispsoft_sim_trace_analytics', { session_id: sid, format: 'csv' });
      assert.equal(trace.success, true, JSON.stringify(trace));
      assert.ok(Number(trace.sample_count) >= 3);
      assert.ok(String(trace.csv).includes('scan_count,elapsed_ms'));
    } finally {
      executeMcpTool('ispsoft_sim_control', { session_id: sid, command: 'CLOSE' });
    }
  }),
);

test(
  'ST multi-instance User FB, REAL floating-point math, and standard IEC FBs in Soft-PLC',
  withIsolatedWorkspace(() => {
    const imp = executeMcpTool('ispsoft_import_project_bundle', {
      output_path: '/workspace/fb_real_test.isp',
      bundle: {
        model: 'AS228T',
        tasks: [{ id: 0, name: 'Main', type: 0, interval_ms: 50, priority: 1, active: true, program: 'MainPrg' }],
        pous: [
          {
            name: 'RampFB',
            language: 'ST',
            pou_type: 'FB',
            local_vars: [
              { name: 'StepVal', type: 'REAL', class: 'VAR_INPUT' },
              { name: 'Acc', type: 'REAL', class: 'VAR_OUTPUT' },
            ],
            code: 'Acc := Acc + StepVal;',
          },
          {
            name: 'MainPrg',
            language: 'ST',
            pou_type: 'PRG',
            local_vars: [
              { name: 'R1', type: 'RampFB', class: 'VAR' },
              { name: 'R2', type: 'RampFB', class: 'VAR' },
              { name: 'Out1', type: 'REAL', class: 'VAR' },
              { name: 'Out2', type: 'REAL', class: 'VAR' },
            ],
            code: [
              'R1(StepVal := 1.5);',
              'R2(StepVal := 0.25);',
              'Out1 := R1.Acc;',
              'Out2 := R2.Acc;',
            ].join('\n'),
          },
        ],
      },
    });
    assert.equal(imp.success, true, JSON.stringify(imp));

    const sim = executeMcpTool('ispsoft_sim_start', { project_path: '/workspace/fb_real_test.isp', scan_interval_ms: 50 });
    const sid = String(sim.session_id);
    try {
      const seq = executeMcpTool('ispsoft_sim_run_sequence', {
        session_id: sid,
        steps: [
          { label: 'Two scans keep independent FB instance states with REAL precision', cycles: 2, expect: { OUT1: 3, OUT2: 0.5 } },
        ],
      });
      assert.equal(seq.success, true, JSON.stringify(seq));
    } finally {
      executeMcpTool('ispsoft_sim_control', { session_id: sid, command: 'CLOSE' });
    }
  }),
);

test(
  'Engineering utilities: MPU import/export, PLCopen XML, IEC ST export, CSV symbols/comments, Device Usage/Allocate, LD/IL<->ST convert, Model Migration, Reference Catalog, Modbus Planner & new MCP resources/prompts',
  withIsolatedWorkspace(() => {
    // 1. Export Prog0 to .mpu and re-import under new name
    const expMpu = executeMcpTool('ispsoft_import_export_pou_package', {
      action: 'export_mpu',
      project_path: '/workspace/sample_es2.isp',
      pou_name: 'Prog0',
      output_path: '/workspace/exported_prog0.mpu',
    });
    assert.equal(expMpu.success, true, JSON.stringify(expMpu));

    const impMpu = executeMcpTool('ispsoft_import_export_pou_package', {
      action: 'import_mpu',
      project_path: '/workspace/sample_es2.isp',
      mpu_path: '/workspace/exported_prog0.mpu',
      pou_name: 'Prog0Copy',
      output_path: '/workspace/with_mpu_copy.isp',
    });
    assert.equal(impMpu.success, true, JSON.stringify(impMpu));

    // 2. PLCopen XML & IEC ST export
    const xml = executeMcpTool('ispsoft_import_export_pou_package', {
      action: 'export_plcopen_xml',
      project_path: '/workspace/sample_es2.isp',
    });
    assert.equal(xml.success, true);
    assert.ok(String(xml.xml).includes('plcopen.org/xml/tc6_0201'));

    const iecSt = executeMcpTool('ispsoft_import_export_pou_package', {
      action: 'export_iec_st',
      project_path: '/workspace/sample_es2.isp',
    });
    assert.equal(iecSt.success, true);
    assert.ok(String(iecSt.st_text).includes('PROGRAM Prog0'));

    // 3. CSV Symbols & Comments round-trip
    const impCsvSym = executeMcpTool('ispsoft_csv_symbols_comments', {
      action: 'import_symbols',
      project_path: '/workspace/sample_es2.isp',
      csv_text: 'Scope,Identifier,DataType,Address,Class,InitialValue,Comment\nGLOBAL,MotorRun,BOOL,Y0,VAR_GLOBAL,FALSE,Main motor\n',
      output_path: '/workspace/csv_test.isp',
    });
    assert.equal(impCsvSym.success, true, JSON.stringify(impCsvSym));
    const expCsvSym = executeMcpTool('ispsoft_csv_symbols_comments', {
      action: 'export_symbols',
      project_path: '/workspace/csv_test.isp',
    });
    assert.equal(expCsvSym.success, true);
    assert.ok(String(expCsvSym.csv).includes('MotorRun'));

    const impCsvCmt = executeMcpTool('ispsoft_csv_symbols_comments', {
      action: 'import_comments',
      project_path: '/workspace/csv_test.isp',
      csv_text: 'Device,Comment\nD100,Tank Level\n',
      in_place: true,
    });
    assert.equal(impCsvCmt.success, true);
    const expCsvCmt = executeMcpTool('ispsoft_csv_symbols_comments', {
      action: 'export_comments',
      project_path: '/workspace/csv_test.isp',
    });
    assert.ok(String(expCsvCmt.csv).includes('Tank Level'));

    // 4. Device usage & free address allocation
    const usage = executeMcpTool('ispsoft_device_usage_and_allocate', {
      project_path: '/workspace/sample_es2.isp',
      action: 'usage_map',
    });
    assert.equal(usage.success, true);
    const alloc = executeMcpTool('ispsoft_device_usage_and_allocate', {
      project_path: '/workspace/sample_es2.isp',
      action: 'allocate',
      area: 'D',
      count: 4,
      start_from: 500,
      contiguous: true,
    });
    assert.equal(alloc.success, true);
    assert.deepEqual(alloc.allocated, ['D500', 'D501', 'D502', 'D503']);

    // 5. Program converter (LD -> ST, IL -> ST, ST -> IL)
    const ld2st = executeMcpTool('ispsoft_convert_program', {
      direction: 'ld_pou_to_st',
      project_path: '/workspace/sample_es2.isp',
      pou_name: 'Prog0',
    });
    assert.equal(ld2st.success, true);
    assert.ok(String(ld2st.st_code).length > 0);

    const st2il = executeMcpTool('ispsoft_convert_program', {
      direction: 'st_to_il',
      code: 'IF X0 THEN D10 := D0 + 5; END_IF;',
    });
    assert.equal(st2il.success, true);
    assert.ok(String(st2il.il_code).includes('ADD D0 K5 D10'));

    // 6. Cross-family model migration (ES2 -> AS228T)
    const mig = executeMcpTool('ispsoft_migrate_project_model', {
      project_path: '/workspace/sample_es2.isp',
      target_model: 'AS228T',
      output_path: '/workspace/migrated_as228t.isp',
    });
    assert.equal(mig.success, true, JSON.stringify(mig));
    assert.equal(mig.target_family, 'AS');
    assert.ok(Array.isArray(mig.warnings) && (mig.warnings as string[]).length > 0);

    // 7. Reference catalog lookup
    const refInst = executeMcpTool('ispsoft_lookup_reference', { topic: 'instructions', query: 'PID' });
    assert.equal(refInst.success, true);
    assert.ok((refInst.instructions as unknown[]).length >= 1);

    const refMod = executeMcpTool('ispsoft_lookup_reference', { topic: 'extension_modules', query: 'DVP04AD' });
    assert.equal(refMod.success, true);
    assert.ok((refMod.extension_modules as unknown[]).length >= 1);

    // 8. Multi-series Modbus forward/reverse/frame planner
    const asMap = executeMcpTool('ispsoft_map_dvp_modbus_addresses', {
      model: 'AS228T',
      addresses: ['D100', 'X0.5', 'SM400'],
    });
    assert.equal(asMap.success, true, JSON.stringify(asMap));
    assert.equal(asMap.mapped_count, 3);

    const rev = executeMcpTool('ispsoft_modbus_planner', {
      action: 'reverse',
      model: 'ES2',
      pdu_address: 0x1064,
      function_code: 3,
    });
    assert.equal(rev.success, true);
    assert.equal((rev.match as Record<string, unknown>).device, 'D100');

    const frame = executeMcpTool('ispsoft_modbus_planner', {
      action: 'plan_frame',
      model: 'ES2',
      device: 'D100',
      operation: 'read',
      slave_id: 1,
      count: 2,
    });
    assert.equal(frame.success, true);
    assert.ok(String(frame.rtu_hex).startsWith('01 03 10 64 00 02'));
    assert.ok(String(frame.tcp_hex).includes('01 03 10 64 00 02'));

    // 9. New MCP resources and prompts
    const refRes = handleSingleRpc(
      { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'ispsoft://reference/instructions' } },
      { requestId: 'r-ref' },
    );
    assert.equal(refRes.status, 200);
    assert.ok(((refRes.body?.result as Record<string, unknown>).contents as unknown[]).length === 1);

    const hwRes = handleSingleRpc(
      { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'ispsoft://projects/sample_es2.isp/hwconfig' } },
      { requestId: 'r-hw' },
    );
    assert.equal(hwRes.status, 200);
    assert.ok(((hwRes.body?.result as Record<string, unknown>).contents as unknown[]).length === 1);

    const promptRes = handleSingleRpc(
      { jsonrpc: '2.0', id: 3, method: 'prompts/get', params: { name: 'design_sfc_state_machine', arguments: { project_path: '/workspace/sample_es2.isp', pou_name: 'Seq0' } } },
      { requestId: 'r-prompt' },
    );
    assert.equal(promptRes.status, 200);
    assert.ok(((promptRes.body?.result as Record<string, unknown>).messages as unknown[]).length === 1);
  }),
);
