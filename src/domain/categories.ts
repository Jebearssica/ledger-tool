/**
 * Category rules. See AGENTS.md §7.
 *
 * Rules are data, not code, so they can be unit-tested and edited by the user
 * without touching the engine. Matching is deliberately simple substring
 * matching by default: Chinese merchant names are short and regexes over them
 * cause more false positives than they prevent.
 */
import type { DraftTransaction, Transaction } from './types';

export type RuleField = 'counterparty' | 'description' | 'txType' | 'method' | 'any';

export interface CategoryRule {
  id: string;
  field: RuleField;
  /** Literal keyword (substring, case-insensitive) unless `isRegex` is set. */
  pattern: string;
  isRegex?: boolean;
  flags?: string;
  category: string;
  /** Higher wins. Ties break on declaration order. */
  priority: number;
}

export interface CategoryDef {
  id: string;
  label: string;
  /** Whether this category applies to spending or to income. */
  appliesTo: 'expense' | 'income';
}

export const DEFAULT_CATEGORIES: readonly CategoryDef[] = [
  { id: 'food', label: '餐饮', appliesTo: 'expense' },
  { id: 'transport', label: '交通', appliesTo: 'expense' },
  { id: 'groceries', label: '日用品', appliesTo: 'expense' },
  { id: 'shopping', label: '购物', appliesTo: 'expense' },
  { id: 'housing', label: '房租物业', appliesTo: 'expense' },
  { id: 'utilities', label: '水电燃气', appliesTo: 'expense' },
  { id: 'communication', label: '通讯', appliesTo: 'expense' },
  { id: 'entertainment', label: '娱乐', appliesTo: 'expense' },
  { id: 'medical', label: '医疗', appliesTo: 'expense' },
  { id: 'education', label: '教育', appliesTo: 'expense' },
  { id: 'clothing', label: '服饰', appliesTo: 'expense' },
  { id: 'travel', label: '旅行', appliesTo: 'expense' },
  { id: 'digital', label: '数码', appliesTo: 'expense' },
  { id: 'express', label: '快递物流', appliesTo: 'expense' },
  { id: 'pet', label: '宠物', appliesTo: 'expense' },
  { id: 'fees', label: '手续费利息', appliesTo: 'expense' },
  { id: 'other', label: '其他', appliesTo: 'expense' },
  { id: 'salary', label: '工资', appliesTo: 'income' },
  { id: 'bonus', label: '奖金', appliesTo: 'income' },
  { id: 'investment-income', label: '投资收益', appliesTo: 'income' },
  { id: 'other-income', label: '其他收入', appliesTo: 'income' },
];

const expenseRule = (
  id: string,
  category: string,
  pattern: string,
  priority = 10,
): CategoryRule => ({ id, field: 'any', pattern, category, priority });

/**
 * Seed ruleset. Intentionally small and readable — the user is expected to
 * extend it. Ordering is irrelevant because `priority` is explicit.
 */
export const DEFAULT_RULES: readonly CategoryRule[] = [
  expenseRule('r-food-1', 'food', '美团'),
  expenseRule('r-food-2', 'food', '饿了么'),
  expenseRule('r-food-3', 'food', '餐饮'),
  expenseRule('r-food-4', 'food', '餐厅'),
  expenseRule('r-food-5', 'food', '饭店'),
  expenseRule('r-food-6', 'food', '美食'),
  expenseRule('r-food-7', 'food', '肯德基'),
  expenseRule('r-food-8', 'food', '麦当劳'),
  expenseRule('r-food-9', 'food', '星巴克'),
  expenseRule('r-food-10', 'food', '瑞幸'),
  expenseRule('r-food-11', 'food', '外卖'),
  expenseRule('r-food-12', 'food', '食品'),

  expenseRule('r-transport-1', 'transport', '滴滴'),
  expenseRule('r-transport-2', 'transport', '高德'),
  expenseRule('r-transport-3', 'transport', '地铁'),
  expenseRule('r-transport-4', 'transport', '公交'),
  expenseRule('r-transport-5', 'transport', '12306'),
  expenseRule('r-transport-6', 'transport', '铁路'),
  expenseRule('r-transport-7', 'transport', '加油'),
  expenseRule('r-transport-8', 'transport', '停车'),
  expenseRule('r-transport-9', 'transport', '出租车'),
  expenseRule('r-transport-10', 'transport', '打车'),
  expenseRule('r-transport-11', 'transport', '单车'),
  expenseRule('r-transport-12', 'transport', '骑行'),
  expenseRule('r-transport-13', 'transport', '地铁'),
  expenseRule('r-transport-14', 'transport', '航空'),
  expenseRule('r-transport-15', 'transport', '航班'),

  expenseRule('r-groceries-1', 'groceries', '超市'),
  expenseRule('r-groceries-2', 'groceries', '便利店'),
  expenseRule('r-groceries-3', 'groceries', '生鲜'),
  expenseRule('r-groceries-4', 'groceries', '永辉'),
  expenseRule('r-groceries-5', 'groceries', '盒马'),
  expenseRule('r-groceries-6', 'groceries', '沃尔玛'),
  expenseRule('r-groceries-7', 'groceries', '家乐福'),

  expenseRule('r-shopping-1', 'shopping', '淘宝'),
  expenseRule('r-shopping-2', 'shopping', '天猫'),
  expenseRule('r-shopping-3', 'shopping', '京东'),
  expenseRule('r-shopping-4', 'shopping', '拼多多'),
  expenseRule('r-shopping-5', 'shopping', '唯品会'),
  expenseRule('r-shopping-6', 'shopping', '苏宁'),

  expenseRule('r-housing-1', 'housing', '房租', 20),
  expenseRule('r-housing-2', 'housing', '租金', 20),
  expenseRule('r-housing-3', 'housing', '物业'),

  expenseRule('r-utilities-1', 'utilities', '电费'),
  expenseRule('r-utilities-2', 'utilities', '水费'),
  expenseRule('r-utilities-3', 'utilities', '燃气'),
  expenseRule('r-utilities-4', 'utilities', '天然气'),
  expenseRule('r-utilities-5', 'utilities', '网上国网'),
  expenseRule('r-utilities-6', 'utilities', '国家电网'),

  expenseRule('r-communication-1', 'communication', '中国移动'),
  expenseRule('r-communication-2', 'communication', '中国联通'),
  expenseRule('r-communication-3', 'communication', '中国电信'),
  expenseRule('r-communication-4', 'communication', '话费'),
  expenseRule('r-communication-5', 'communication', '流量'),

  expenseRule('r-entertainment-1', 'entertainment', '电影'),
  expenseRule('r-entertainment-2', 'entertainment', '影院'),
  expenseRule('r-entertainment-3', 'entertainment', '腾讯视频'),
  expenseRule('r-entertainment-4', 'entertainment', '爱奇艺'),
  expenseRule('r-entertainment-5', 'entertainment', '优酷'),
  expenseRule('r-entertainment-6', 'entertainment', '哔哩哔哩'),
  expenseRule('r-entertainment-7', 'entertainment', 'steam'),
  expenseRule('r-entertainment-8', 'entertainment', '游戏'),

  expenseRule('r-medical-1', 'medical', '医院'),
  expenseRule('r-medical-2', 'medical', '药房'),
  expenseRule('r-medical-3', 'medical', '药店'),
  expenseRule('r-medical-4', 'medical', '诊所'),
  expenseRule('r-medical-5', 'medical', '体检'),
  expenseRule('r-medical-6', 'medical', '胶囊'),
  expenseRule('r-medical-7', 'medical', '医保'),
  expenseRule('r-medical-8', 'medical', '门诊'),

  expenseRule('r-education-1', 'education', '学费'),
  expenseRule('r-education-2', 'education', '培训'),
  expenseRule('r-education-3', 'education', '教育'),
  expenseRule('r-education-4', 'education', '书店'),
  expenseRule('r-education-5', 'education', '图书'),

  expenseRule('r-clothing-1', 'clothing', '服饰'),
  expenseRule('r-clothing-2', 'clothing', '服装'),
  expenseRule('r-clothing-3', 'clothing', '优衣库'),
  expenseRule('r-clothing-4', 'clothing', '耐克'),
  expenseRule('r-clothing-5', 'clothing', '阿迪达斯'),

  expenseRule('r-travel-1', 'travel', '携程'),
  expenseRule('r-travel-2', 'travel', '去哪儿'),
  expenseRule('r-travel-3', 'travel', '酒店'),
  expenseRule('r-travel-4', 'travel', '民宿'),
  expenseRule('r-travel-5', 'travel', '机票'),

  expenseRule('r-digital-1', 'digital', '苹果'),
  expenseRule('r-digital-2', 'digital', '华为'),
  expenseRule('r-digital-3', 'digital', '小米'),

  expenseRule('r-express-1', 'express', '快递'),
  expenseRule('r-express-2', 'express', '寄件'),
  expenseRule('r-express-3', 'express', '物流'),
  expenseRule('r-express-4', 'express', '菜鸟'),

  expenseRule('r-pet-1', 'pet', '宠物'),
  expenseRule('r-pet-2', 'pet', '猫'),
  expenseRule('r-pet-3', 'pet', '狗'),

  // Fees are real spending even when they ride along with a repayment row.
  expenseRule('r-fees-1', 'fees', '手续费', 30),
  expenseRule('r-fees-2', 'fees', '服务费', 30),
  expenseRule('r-fees-3', 'fees', '逾期费', 30),
  expenseRule('r-fees-4', 'fees', '违约金', 30),

  expenseRule('r-income-1', 'salary', '工资', 25),
  expenseRule('r-income-2', 'salary', '薪资', 25),
  expenseRule('r-income-3', 'bonus', '奖金', 25),
  expenseRule('r-income-4', 'bonus', '年终奖', 25),
  expenseRule('r-income-5', 'investment-income', '利息', 25),
  expenseRule('r-income-6', 'investment-income', '结息', 25),
  expenseRule('r-income-7', 'investment-income', '收益', 25),
];

function fieldValues(draft: DraftTransaction, field: RuleField): string[] {
  switch (field) {
    case 'counterparty':
      return [draft.counterparty ?? ''];
    case 'description':
      return [draft.description];
    case 'txType':
      return [draft.txType ?? ''];
    case 'method':
      return [draft.method ?? ''];
    case 'any':
      return [draft.counterparty ?? '', draft.description, draft.txType ?? '', draft.method ?? ''];
  }
}

function ruleMatches(rule: CategoryRule, draft: DraftTransaction): boolean {
  if (rule.pattern === '') return false;
  for (const value of fieldValues(draft, rule.field)) {
    if (value === '') continue;
    if (rule.isRegex) {
      try {
        if (new RegExp(rule.pattern, rule.flags ?? 'i').test(value)) return true;
      } catch {
        // A user-authored rule with an invalid regex must not break the import.
        return false;
      }
    } else if (value.toLowerCase().includes(rule.pattern.toLowerCase())) {
      return true;
    }
  }
  return false;
}

export interface CategoryAssignment {
  category?: string;
  categorySource: 'rule' | 'user' | 'none';
}

/**
 * Choose a category for a draft.
 *
 * Categorisation applies to expenses only (AGENTS.md §7). Income keeps a label
 * too, but through the same rule table, so `appliesTo` is not enforced here —
 * the pipeline passes only the drafts it wants categorised.
 */
export function categorize(draft: DraftTransaction, rules: readonly CategoryRule[]): CategoryAssignment {
  const ordered = [...rules].sort((a, b) => b.priority - a.priority);
  for (const rule of ordered) {
    if (ruleMatches(rule, draft)) {
      return { category: rule.category, categorySource: 'rule' };
    }
  }
  return { categorySource: 'none' };
}

/**
 * Re-apply rules to an existing transaction, but never overwrite a category the
 * user set by hand. Re-importing the same batch must not undo their fixes.
 */
export function recategorize(tx: Transaction, rules: readonly CategoryRule[]): Transaction {
  if (tx.categorySource === 'user') return tx;

  const draftLike: DraftTransaction = {
    source: tx.source,
    accountId: tx.accountId,
    direction: tx.direction,
    amountMinor: tx.amountMinor,
    currency: tx.currency,
    occurredAt: tx.occurredAt,
    counterparty: tx.counterparty,
    description: tx.rawDescription,
    excludedFromCashflow: false,
    raw: {},
  };

  const assignment = categorize(draftLike, rules);
  return { ...tx, category: assignment.category, categorySource: assignment.categorySource };
}

export function categoryLabel(id: string | undefined, categories: readonly CategoryDef[]): string {
  if (!id) return '未分类';
  return categories.find((c) => c.id === id)?.label ?? id;
}
