import { z } from 'zod';
import type { Workspace } from '../src/lib/workflow.ts';
import { invalid } from './errors.ts';

const short = z.string().max(500);
const file = z.object({
  id: short.min(1), name: short.min(1), kind: z.enum(['code','hardware','log','note','other']),
  content: z.string().max(1024 * 1024), size: z.number().nonnegative(), updatedAt: short,
  source: z.enum(['sample','uploaded','generated']), mimeType: short.optional(),
  relativePath: short.optional(), linked: z.boolean().optional(), hash: short.optional(), includeInContext: z.boolean().optional(),
});
const observation = z.object({
  joint: z.enum(['J1','J2','J3','J4']), issues: z.array(z.enum(['Too fast','No motion','Wrong way','Shaking','Error message','Other'])).max(6),
  phase: z.enum(['Home','Reach','Pause','Return']), detail: z.string().max(50000), desired: z.array(short).max(30), includePrevious: z.boolean(),
});
const round = z.object({
  id: short.min(1), number: z.number().int().positive(), observation, applied: z.boolean(),
  createdAt: short, completedAt: short.optional(), result: z.enum(['Better','Same','Worse','Not sure']).optional(), note: z.string().max(50000).optional(),
  suggestion: z.record(z.string(), z.unknown()).optional(), operationId: short.optional(),
});
const task = z.object({
  id: short.min(1), name: short.min(1), hardware: z.object({ name: short, controller: short, connection: short, joints: z.number(), gripper: z.boolean(), notes: z.string().max(50000), configured: z.boolean() }).passthrough(),
  files: z.array(file).max(500), rounds: z.array(round).min(1).max(1000), activeRoundId: short, createdAt: short,
  rootId: short.optional(), rootPath: z.string().max(4096).optional(),
});
const workspace = z.object({ version: z.literal(1), tasks: z.array(task).min(1).max(100), activeTaskId: short, stage: z.enum(['setup','first-run','observe','request','investigating','review','applying','test','feedback']) });

export function validateWorkspace(value: unknown): Workspace {
  const parsed = workspace.safeParse(value);
  if (!parsed.success) throw invalid(`Invalid workspace: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
  const state = parsed.data;
  const taskIds = new Set<string>();
  let bytes = 0;
  for (const t of state.tasks) {
    if (taskIds.has(t.id)) throw invalid('Duplicate task ID.');
    taskIds.add(t.id);
    if (!t.rounds.some(r => r.id === t.activeRoundId)) throw invalid('Active round is missing.');
    if (new Set(t.rounds.map(r => r.id)).size !== t.rounds.length || new Set(t.files.map(f => f.id)).size !== t.files.length || new Set(t.files.map(f => f.relativePath ?? f.name)).size !== t.files.length) throw invalid('Duplicate file or round identity.');
    for (const f of t.files) {
      const count = Buffer.byteLength(f.content);
      if (count > 1024 * 1024 || f.content.includes('\0')) throw invalid('Only text files up to 1 MB are supported.');
      f.size = count;
      bytes += count;
    }
  }
  if (!taskIds.has(state.activeTaskId)) throw invalid('Active task is missing.');
  if (bytes > 12 * 1024 * 1024) throw invalid('Workspace exceeds 12 MB. Export or remove unused files.');
  return state as unknown as Workspace;
}

export const diagnosisSchema = z.object({
  outcome: z.enum(['proposal','needs_information']), title: z.string().min(1).max(500), summary: z.string().max(10000), rationale: z.string().max(30000),
  evidence: z.array(z.string().max(3000)).max(50), questions: z.array(z.string().max(3000)).max(20), risk: z.string().max(10000),
  changes: z.array(z.object({ path: z.string().min(1).max(500), afterContent: z.string().max(1024 * 1024) }).strict()).max(30),
}).strict();
export const diagnosisOutputSchema: Record<string, unknown> = {
  type: 'object', additionalProperties: false,
  properties: {
    outcome: { type: 'string', enum: ['proposal','needs_information'] }, title: { type: 'string' }, summary: { type: 'string' }, rationale: { type: 'string' }, risk: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } }, questions: { type: 'array', items: { type: 'string' } },
    changes: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, afterContent: { type: 'string' } }, required: ['path','afterContent'] } },
  },
  required: ['outcome','title','summary','rationale','evidence','questions','risk','changes'],
};
