/* 共享领域类型：主进程、渲染进程、测试三方共用，改一处即可 */

export type NodeKind = 'concept' | 'skill' | 'root'

/**
 * 权重来源。区分"这个数是怎么来的"，决定界面上能不能叫它"考频"。
 * - ai：模型生成章节时给的估计，没有任何真实考试数据支撑
 * - manual：人工整理/校对过的课程重要性，仍然**不是**历年考频统计
 * - stats：真的统计过历年真题（需要年份与样本量），目前**没有任何节点属于这一档**
 */
export type WeightSource = 'ai' | 'manual' | 'stats'

export interface ScopeItem { id: string; label: string }

export interface ScopeSpec {
  version: number
  source: 'confirmed' | 'legacy'
  stage: string
  subject: string
  topic: string
  goal: string
  depth: string
  include: ScopeItem[]
  exclude: string[]
  foundations: ScopeItem[]
}

export interface KNode {
  id: string
  name: string
  parentId: string | null
  kind: NodeKind
  /** 重要性 0..1。注意：这是"重要程度"的估计，不是历史考察频率 */
  examWeight: number
  /** examWeight 的来源，缺省按 'ai' 处理 */
  weightSource?: WeightSource
  weightLocked?: boolean
  edited?: boolean
  scopeIds?: string[]
  supplementary?: boolean
  /** 前置考点：不会它，本篇学不动 */
  prereq: string[]
  /** 容易混淆的考点（对称） */
  confusable: string[]
  /** 讲解（预写，v0.1 不走 AI） */
  brief?: string
  /** 融合后的板块里，这个节点原本属于哪一章（出题时用它当上下文，防止串味） */
  origin?: string
}

export interface Relation {
  /** 前置：不会 a 就学不动 b；易混：a 与 b 互相干扰 */
  a: string
  b: string
  kind: 'prereq' | 'confusable'
  /** 一句话说清"为什么"，画在连线中间 */
  why: string
}

export interface Pack {
  packId: string
  title: string
  subject: string
  totalScore: number
  source: string
  /** 大厅里用来分组展示：哪个考试、哪一科、哪一章 */
  meta?: { exam: string; subject: string; chapter: string }
  nodes: KNode[]
  relations?: Relation[]
  scope?: ScopeSpec
  revision?: string
}

export type QuestionType = 'single' | 'blank' | 'judge'

export interface Tag {
  nodeId: string
  /** 主考点 1.0，次考点 0.4 */
  weight: number
  primary?: boolean
}

export interface Question {
  id: string
  type: QuestionType
  stem: string
  options?: string[]
  /** 判断题：'true' | 'false'；填空题：可接受答案数组 */
  answer: string[] | string
  solution?: string
  /** 1..5 */
  difficulty: number
  tags: Tag[]
}

/**
 * 用户自评：主观报告，**不是**能力估计。
 * - none    没学过
 * - weak    学过但不会
 * - basic   基本掌握
 * - unknown 没表态 / 由旧数据迁移而来（旧 K 混合了自评和答题自动更新，无法分离）
 */
export type SelfLevel = 'none' | 'weak' | 'basic' | 'unknown'

/**
 * 个人知识状态（v2）。
 *
 * 四个概念分开存，不再混在一根乘法里：
 *   ① 自评 SelfLevel   —— 用户主观报告，只影响展示与初始建议，不参与能力计算
 *   ② 能力 Ability     —— A / W / Aw，只由**有效答题证据**更新
 *   ③ 记忆保持 Retention —— s / lastAt 推导，只用于决定什么时候该复习
 *   ④ 可信度 Confidence  —— 由 W（衰减后的有效样本量）推导，独立于能力高低
 *
 * 老字段 K 保留为历史值：v1 里它既被自评改、又被答对自动抬，
 * 已经分不出哪部分来自用户、哪部分来自答题，所以不再参与任何计算。
 */
export interface Mastery {
  /** 历史覆盖度。v2 起不参与计算，仅保留旧数据 */
  K: number
  /** 能力估计（证据驱动，A = Aw / W） */
  A: number
  /** 稳定性（天），用于遗忘曲线 */
  s: number
  /** 累计有效作答次数（疑似蒙对不计） */
  n: number
  nok: number
  /** 时间衰减后的权重和 = 有效样本量，用来算可信度 */
  W: number
  /** 时间衰减后的加权正确和 */
  Aw: number
  /** 错误概念已固化 */
  misconception: 0 | 1
  lastAt: number | null
  /**
   * 这个状态是怎么来的：
   * - none  什么信息都没有
   * - self  只有用户自评，还没做过一道题
   * - tested 至少有过一次有效作答
   * 读取时以 n/K 推导为准（见 evidenceOf），字段只作记录。
   */
  evidence?: 'none' | 'self' | 'tested'
  /** 数据结构版本：2 = 自评/能力/保持/可信度已拆分 */
  schemaVersion?: number
  /** 用户自评档位（主观，不是能力） */
  selfLevel?: SelfLevel
  /** 自评时间 */
  selfAt?: number | null
  /** 能力估计的来源：v1 是旧模型算的（迁移而来），v2 是拆分后的证据模型 */
  abilityFrom?: 'v1' | 'v2'
}

export type SelfConfidence = 'sure' | 'unsure' | 'unknown'

export type ErrorReason =
  | 'calc' | 'formula' | 'misread' | 'concept' | 'method' | 'guess' | null

export type TaskKind = 'review' | 'gap' | 'diagnose' | 'new'

export interface Task {
  id: string
  date: string
  kind: TaskKind
  nodeId: string
  questionIds: string[]
  estMinutes: number
  status: 'pending' | 'done' | 'postponed'
  sortOrder: number
  stepId?: string
  spentMinutes?: number
}

export interface DiagnosticRound {
  askedIds: string[]
  answered: { questionId: string; nodeId: string; correct: boolean; guessed?: boolean }[]
  targetDifficulty: number
  finished?: boolean
  revision?: string
}

export interface LearningSignal {
  nodeId: string
  at: number
  kind: 'question' | 'explain' | 'card' | 'confusion'
  questionId?: string
}

export interface PathStep {
  id: string
  nodeId: string
  action: 'diagnose' | 'gap' | 'review'
  prerequisites: string[]
  blockedBy: string[]
  dependents: string[]
  invalid: boolean
  evidence: string
  reason: string
  done?: boolean
}

export interface LearningPath {
  packId: string
  revision: string
  version: number
  steps: PathStep[]
  checkedAt: number
  reason: string
}

/** 一次作答对某个考点的证据分量（一道题可能同时挂多个考点） */
export interface AttemptTag {
  nodeId: string
  weight: number
  primary: boolean
}

export interface AttemptRecord {
  id: string
  questionId: string
  nodePrimary: string
  startedAt: number
  submittedAt: number
  durationMs: number
  correct: boolean
  selfConfidence: SelfConfidence
  /** 系统判定疑似蒙对 */
  guessed: boolean
  errorReason: ErrorReason
  /**
   * 本次作答实际影响到的全部考点及权重。
   * 老记录没有这个字段 —— 读的时候按 nodePrimary 兜底（见 nodesOfAttempt）。
   * 存它的理由：一道综合题会同时推动多个节点的掌握度，
   * 只记主节点的话，事后没法回答"这个副考点的分数为什么变了"。
   */
  tags?: AttemptTag[]
}

export interface Settings {
  dailyMinutes: number
  examDate: string
  totalScore: number
  packId: string
}

export interface AppState {
  /** 数据结构版本。2 = 掌握状态已拆成自评/能力/保持/可信度 */
  schemaVersion?: number
  settings: Settings
  mastery: Record<string, Mastery>
  attempts: AttemptRecord[]
  tasks: Task[]
  path?: LearningPath
  diagnostic?: DiagnosticRound
  signals?: LearningSignal[]
}

export interface SubmitPayload {
  questionId: string
  answer: string
  durationMs: number
  selfConfidence: SelfConfidence
  errorReason: ErrorReason
  submissionId?: string
  taskId?: string
  diagnostic?: boolean
}

export type LearningUpdate =
  | { kind: 'checkpoint'; reason: string; completedStep?: string }
  | { kind: 'diagnostic'; round: DiagnosticRound }
  | { kind: 'signal'; signal: LearningSignal }

export interface SubmitResult {
  correct: boolean
  nodeId: string
  before: number
  after: number
  /** 做完这道题，这个考点的色档从哪变到哪（红→橙→黄→绿） */
  beforeBand: 'red' | 'orange' | 'yellow' | 'green' | 'self' | 'unmeasured'
  afterBand: 'red' | 'orange' | 'yellow' | 'green' | 'self' | 'unmeasured'
  guessed: boolean
  solution?: string
  state: AppState
}

export interface LoadResult {
  pack: Pack
  questions: Question[]
  state: AppState
  today: Task[]
}
