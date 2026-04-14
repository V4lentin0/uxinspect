import type { Page } from 'playwright';

export interface DomAuditIssue {
  type: 'too-many-nodes' | 'too-deep' | 'too-wide';
  detail: string;
}

export interface DomAuditResult {
  page: string;
  totalNodes: number;
  maxDepth: number;
  maxChildrenOfAnyNode: number;
  deepestPath?: string;
  widestNodeSelector?: string;
  shadowRoots: number;
  iframes: number;
  issues: DomAuditIssue[];
  passed: boolean;
}

interface DomStats {
  totalNodes: number;
  maxDepth: number;
  maxChildrenOfAnyNode: number;
  deepestPath?: string;
  widestNodeSelector?: string;
  shadowRoots: number;
  iframes: number;
}

export async function auditDomSize(
  page: Page,
  opts?: { maxNodes?: number; maxDepth?: number; maxChildren?: number }
): Promise<DomAuditResult> {
  const maxNodes = opts?.maxNodes ?? 1500;
  const maxDepth = opts?.maxDepth ?? 32;
  const maxChildren = opts?.maxChildren ?? 60;

  const stats: DomStats = await page.evaluate(() => {
    const shortSelector = (el: Element): string => {
      let s = el.tagName.toLowerCase();
      if (el.id) s += `#${el.id}`;
      const firstClass = el.classList?.[0];
      if (firstClass) s += `.${firstClass}`;
      return s;
    };

    const ancestorChain = (el: Element, limit = 8): string => {
      const chain: string[] = [];
      let cur: Element | null = el;
      while (cur && chain.length < limit) {
        chain.unshift(shortSelector(cur));
        cur = cur.parentElement;
      }
      return chain.join(' > ');
    };

    let totalNodes = 0;
    let deepest = 0;
    let deepestEl: Element | null = null;
    let widestCount = 0;
    let widestEl: Element | null = null;
    let shadowRoots = 0;
    let iframes = 0;

    const root = document.documentElement;
    if (!root) {
      return {
        totalNodes: 0,
        maxDepth: 0,
        maxChildrenOfAnyNode: 0,
        shadowRoots: 0,
        iframes: 0,
      } as DomStats;
    }

    type Frame = { el: Element; depth: number };
    const stack: Frame[] = [{ el: root, depth: 1 }];

    while (stack.length > 0) {
      const frame = stack.pop();
      if (!frame) break;
      const { el, depth } = frame;

      totalNodes += 1;

      if (depth > deepest) {
        deepest = depth;
        deepestEl = el;
      }

      const childCount = el.children.length;
      if (childCount > widestCount) {
        widestCount = childCount;
        widestEl = el;
      }

      if ((el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot) {
        shadowRoots += 1;
      }

      if (el.tagName === 'IFRAME') {
        iframes += 1;
      }

      for (let i = childCount - 1; i >= 0; i--) {
        const child = el.children[i];
        if (child) stack.push({ el: child, depth: depth + 1 });
      }
    }

    return {
      totalNodes,
      maxDepth: deepest,
      maxChildrenOfAnyNode: widestCount,
      deepestPath: deepestEl ? ancestorChain(deepestEl, 8) : undefined,
      widestNodeSelector: widestEl ? shortSelector(widestEl) : undefined,
      shadowRoots,
      iframes,
    };
  });

  const issues: DomAuditIssue[] = [];

  if (stats.totalNodes > maxNodes) {
    issues.push({
      type: 'too-many-nodes',
      detail: `${stats.totalNodes} nodes exceeds limit ${maxNodes}`,
    });
  }

  if (stats.maxDepth > maxDepth) {
    issues.push({
      type: 'too-deep',
      detail: `depth ${stats.maxDepth} exceeds limit ${maxDepth}${stats.deepestPath ? ` at ${stats.deepestPath}` : ''}`,
    });
  }

  if (stats.maxChildrenOfAnyNode > maxChildren) {
    issues.push({
      type: 'too-wide',
      detail: `${stats.widestNodeSelector ?? 'element'} has ${stats.maxChildrenOfAnyNode} children, exceeds limit ${maxChildren}`,
    });
  }

  return {
    page: page.url(),
    totalNodes: stats.totalNodes,
    maxDepth: stats.maxDepth,
    maxChildrenOfAnyNode: stats.maxChildrenOfAnyNode,
    deepestPath: stats.deepestPath,
    widestNodeSelector: stats.widestNodeSelector,
    shadowRoots: stats.shadowRoots,
    iframes: stats.iframes,
    issues,
    passed: issues.length === 0,
  };
}
