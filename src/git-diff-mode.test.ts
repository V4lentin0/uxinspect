import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  fileToRoutes,
  flowMatchesRoutes,
  filterFlowsByChangedRoutes,
  getChangedRoutes,
  type GitRunner,
} from './git-diff-mode.js';
import type { Flow } from './types.js';

describe('fileToRoutes — convention 1 (app/routes/*/page.tsx)', () => {
  test('nested segment maps to route', () => {
    assert.deepEqual(fileToRoutes('app/routes/foo/page.tsx'), ['/foo']);
  });

  test('deeper nested segments preserve path', () => {
    assert.deepEqual(fileToRoutes('app/routes/foo/bar/page.tsx'), ['/foo/bar']);
  });

  test('root page.tsx maps to "/"', () => {
    assert.deepEqual(fileToRoutes('app/routes/page.tsx'), ['/']);
  });

  test('accepts .jsx extension', () => {
    assert.deepEqual(fileToRoutes('app/routes/baz/page.jsx'), ['/baz']);
  });

  test('non-page files under app/routes do not map', () => {
    assert.deepEqual(fileToRoutes('app/routes/foo/util.ts'), []);
  });
});

describe('fileToRoutes — convention 2 (pages/*)', () => {
  test('single-file pages map to route', () => {
    assert.deepEqual(fileToRoutes('pages/foo.tsx'), ['/foo']);
  });

  test('nested page paths preserved', () => {
    assert.deepEqual(fileToRoutes('pages/foo/bar.tsx'), ['/foo/bar']);
  });

  test('index.tsx maps to "/"', () => {
    assert.deepEqual(fileToRoutes('pages/index.tsx'), ['/']);
  });

  test('nested index maps to parent route', () => {
    assert.deepEqual(fileToRoutes('pages/foo/index.tsx'), ['/foo']);
  });
});

describe('fileToRoutes — convention 3 (explicit routeMap)', () => {
  test('explicit map entry produces configured routes', () => {
    const map = { 'src/components/Header.tsx': ['/', '/about'] };
    assert.deepEqual(
      fileToRoutes('src/components/Header.tsx', map).sort(),
      ['/', '/about'].sort(),
    );
  });

  test('routeMap adds leading slash if missing', () => {
    const map = { 'src/lib/foo.ts': ['dashboard'] };
    assert.deepEqual(fileToRoutes('src/lib/foo.ts', map), ['/dashboard']);
  });

  test('unknown file without map returns empty', () => {
    assert.deepEqual(fileToRoutes('src/lib/random.ts'), []);
  });

  test('routeMap + convention combine (same file in both)', () => {
    const map = { 'app/routes/foo/page.tsx': ['/extra'] };
    const result = fileToRoutes('app/routes/foo/page.tsx', map).sort();
    assert.deepEqual(result, ['/extra', '/foo']);
  });
});

describe('getChangedRoutes (with injected git runner)', () => {
  test('maps multi-line git diff output through conventions', async () => {
    const fakeGit: GitRunner = async () =>
      [
        'app/routes/foo/page.tsx',
        'pages/bar.tsx',
        'src/components/Header.tsx',
        '',
      ].join('\n');
    const routes = await getChangedRoutes(
      '/repo',
      'HEAD~1',
      { 'src/components/Header.tsx': ['/'] },
      { runGit: fakeGit },
    );
    assert.deepEqual(routes.sort(), ['/', '/bar', '/foo'].sort());
  });

  test('dedupes when multiple files point to the same route', async () => {
    const fakeGit: GitRunner = async () =>
      ['app/routes/foo/page.tsx', 'pages/foo.tsx'].join('\n');
    const routes = await getChangedRoutes('/repo', 'HEAD~1', undefined, {
      runGit: fakeGit,
    });
    assert.deepEqual(routes, ['/foo']);
  });

  test('returns [] when git runner throws', async () => {
    const fakeGit: GitRunner = async () => {
      throw new Error('not a git repo');
    };
    const routes = await getChangedRoutes('/repo', undefined, undefined, {
      runGit: fakeGit,
    });
    assert.deepEqual(routes, []);
  });

  test('returns [] when no files changed', async () => {
    const fakeGit: GitRunner = async () => '';
    const routes = await getChangedRoutes('/repo', undefined, undefined, {
      runGit: fakeGit,
    });
    assert.deepEqual(routes, []);
  });

  test('uses explicit baseRef when passed', async () => {
    let capturedArgs: string[] = [];
    const fakeGit: GitRunner = async (args) => {
      capturedArgs = args;
      return '';
    };
    await getChangedRoutes('/repo', 'origin/main', undefined, {
      runGit: fakeGit,
    });
    assert.deepEqual(capturedArgs, ['diff', '--name-only', 'origin/main']);
  });

  test('falls back to HEAD~1 when no baseRef and no env', async () => {
    const prev = process.env.GITHUB_BASE_REF;
    delete process.env.GITHUB_BASE_REF;
    let capturedArgs: string[] = [];
    const fakeGit: GitRunner = async (args) => {
      capturedArgs = args;
      return '';
    };
    try {
      await getChangedRoutes('/repo', undefined, undefined, { runGit: fakeGit });
      assert.deepEqual(capturedArgs, ['diff', '--name-only', 'HEAD~1']);
    } finally {
      if (prev !== undefined) process.env.GITHUB_BASE_REF = prev;
    }
  });

  test('honours GITHUB_BASE_REF env var', async () => {
    const prev = process.env.GITHUB_BASE_REF;
    process.env.GITHUB_BASE_REF = 'main';
    let capturedArgs: string[] = [];
    const fakeGit: GitRunner = async (args) => {
      capturedArgs = args;
      return '';
    };
    try {
      await getChangedRoutes('/repo', undefined, undefined, { runGit: fakeGit });
      assert.deepEqual(capturedArgs, ['diff', '--name-only', 'origin/main']);
    } finally {
      if (prev === undefined) delete process.env.GITHUB_BASE_REF;
      else process.env.GITHUB_BASE_REF = prev;
    }
  });
});

describe('flowMatchesRoutes', () => {
  const fooFlow: Flow = {
    name: 'foo',
    steps: [{ goto: 'https://site.test/foo' }, { click: 'button' }],
  };
  const barFlow: Flow = {
    name: 'bar',
    steps: [{ goto: '/bar?q=1' }],
  };
  const deepFlow: Flow = {
    name: 'deep',
    steps: [{ goto: 'https://site.test/foo/bar/baz' }],
  };

  test('matches exact path', () => {
    assert.equal(flowMatchesRoutes(fooFlow, ['/foo']), true);
  });

  test('matches sub-path (changed /foo affects /foo/bar/baz)', () => {
    assert.equal(flowMatchesRoutes(deepFlow, ['/foo']), true);
  });

  test('does not match unrelated route', () => {
    assert.equal(flowMatchesRoutes(fooFlow, ['/bar']), false);
  });

  test('root "/" matches every flow', () => {
    assert.equal(flowMatchesRoutes(barFlow, ['/']), true);
    assert.equal(flowMatchesRoutes(fooFlow, ['/']), true);
  });

  test('empty changed routes matches nothing', () => {
    assert.equal(flowMatchesRoutes(fooFlow, []), false);
  });

  test('handles path-only gotos with query strings', () => {
    assert.equal(flowMatchesRoutes(barFlow, ['/bar']), true);
  });

  test('flow with no goto step does not match', () => {
    const noGoto: Flow = { name: 'x', steps: [{ click: 'a' }] };
    assert.equal(flowMatchesRoutes(noGoto, ['/foo']), false);
  });
});

describe('filterFlowsByChangedRoutes', () => {
  const flows: Flow[] = [
    { name: 'home', steps: [{ goto: 'https://site.test/' }] },
    { name: 'foo', steps: [{ goto: 'https://site.test/foo' }] },
    { name: 'bar', steps: [{ goto: 'https://site.test/bar' }] },
  ];

  test('filters to only flows matching changed routes', () => {
    const filtered = filterFlowsByChangedRoutes(flows, ['/foo']);
    assert.deepEqual(
      filtered.map((f) => f.name),
      ['foo'],
    );
  });

  test('empty routes -> empty result', () => {
    assert.deepEqual(filterFlowsByChangedRoutes(flows, []), []);
  });

  test('root "/" route returns all flows', () => {
    const filtered = filterFlowsByChangedRoutes(flows, ['/']);
    assert.equal(filtered.length, flows.length);
  });

  test('multiple changed routes union the matches', () => {
    const filtered = filterFlowsByChangedRoutes(flows, ['/foo', '/bar']);
    assert.deepEqual(
      filtered.map((f) => f.name).sort(),
      ['bar', 'foo'],
    );
  });
});
