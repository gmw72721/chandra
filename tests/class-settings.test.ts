import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const repoRoot = process.cwd();
const classSettings = loadClassSettingsModule();

test("normalizeAnswerPolicySettings fills default help limits", () => {
  assert.deepEqual(
    classSettings.normalizeAnswerPolicySettings(null).helpLimitsByUnderstandingLevel,
    classSettings.defaultAnswerPolicySettings.helpLimitsByUnderstandingLevel
  );
});

test("normalizeAnswerPolicySettings safely handles partial and malformed help limits", () => {
  const normalized = classSettings.normalizeAnswerPolicySettings({
    helpLimitsByUnderstandingLevel: {
      0: "full_explanation_allowed",
      1: "not-a-real-limit",
      2: 2,
      3: "one_worked_step"
    }
  });

  assert.equal(normalized.helpLimitsByUnderstandingLevel[0], "full_explanation_allowed");
  assert.equal(normalized.helpLimitsByUnderstandingLevel[1], "light_hint");
  assert.equal(normalized.helpLimitsByUnderstandingLevel[2], "targeted_hint_next_action");
  assert.equal(normalized.helpLimitsByUnderstandingLevel[3], "one_worked_step");
  assert.equal(normalized.helpLimitsByUnderstandingLevel[4], "check_work_explain_gaps");
});

test("class access roles and TA permissions normalize conservatively", () => {
  assert.ok(classSettings.classAccessRoleOptions.includes("ta"));

  const ta = classSettings.normalizeCoTeacher({
    email: "TA@Example.com",
    permissions: {
      manageRoster: true,
      teacherPreviewChat: true
    },
    role: "ta",
    uid: "ta-1"
  });

  assert.equal(ta.role, "ta");
  assert.equal(ta.email, "ta@example.com");
  assert.equal(ta.permissions.viewOverview, true);
  assert.equal(ta.permissions.manageRoster, true);
  assert.equal(ta.permissions.manageMaterials, false);
  assert.equal(ta.permissions.teacherPreviewChat, true);

  const coTeacher = classSettings.normalizeCoTeacher({
    email: "teacher@example.com",
    role: "co-teacher",
    uid: "teacher-1"
  });

  assert.equal(coTeacher.permissions.deleteStudentData, true);
});

test("teacher settings form submits help limits with answer policy", () => {
  const source = readFileSync(join(repoRoot, "frontend/components/TeacherClassManager.tsx"), "utf8");

  assert.match(source, /helpLimitsByUnderstandingLevel:\s*normalizeAnswerPolicySettings/);
  assert.match(source, /answerPolicy\.helpLimitsByUnderstandingLevel\.\$\{level\}/);
  assert.match(source, /name=\{`answerPolicy\.helpLimitsByUnderstandingLevel\.\$\{level\}`\}/);
  assert.match(source, /updateTeacherClassSettings\(\{\s*answerPolicy,/s);
});

test("class model settings derive token caps from student message caps", () => {
  const normalized = classSettings.normalizeClassModelSettings({
    requestLimits: {
      perStudentDaily: 20,
      perStudentWeekly: 100,
      perClassDaily: 3000,
      teacherPreviewDaily: 50
    },
    tokenLimits: {
      perHour: 50_000,
      perDay: 400_000,
      perWeek: 1_600_000
    }
  });

  assert.equal(normalized.requestLimits.perStudentDaily, 20);
  assert.equal(normalized.requestLimits.perStudentWeekly, 100);
  assert.equal(normalized.tokenLimits.perDay, 20_000);
  assert.equal(normalized.tokenLimits.perWeek, 100_000);
});

function loadClassSettingsModule() {
  const source = readFileSync(join(repoRoot, "frontend/lib/class-settings.ts"), "utf8").replace(
    /import \{ defaultOpenRouterModelId \} from "\.\/model-options";/,
    'const defaultOpenRouterModelId = "test-model";'
  );
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  const moduleShim = { exports: {} as Record<string, any> };
  vm.runInNewContext(transpiled, { exports: moduleShim.exports, module: moduleShim });
  return moduleShim.exports;
}
