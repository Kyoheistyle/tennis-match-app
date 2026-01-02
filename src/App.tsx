import { useEffect, useMemo, useState } from 'react';
import { supabase } from './lib/supabase'
import './App.css';

const STORAGE_NAMESPACE = 'tennisMatchApp:league';
const ACTIVE_LEAGUE_KEY = 'tennisMatchApp:activeLeague';
const LEGACY_STORAGE_KEY = 'tennis-match-progress';

type LeagueId = 'A' | 'B' | 'C' | 'D' | 'E';
const LEAGUES: LeagueId[] = ['A', 'B', 'C', 'D', 'E'];

type LegacyStoredState = {
  pairCount: number;
  completedIds: string[];
};

type LeagueState = {
  pairCount: number;
  completedMap: Record<string, boolean>;
};

type Match = {
  id: string;
  pairA: number;
  pairB: number;
};

type MatchRow = {
  league: LeagueId;
  match_key: string;
  completed: boolean;
};

// ★ここに追加
const MIN_PAIR_COUNT = 2;
const MAX_PAIR_COUNT = 100;

const defaultLeagueState: LeagueState = {
  pairCount: 4,
  completedMap: {},
};

const generateMatches = (pairCount: number): Match[] => {
  // サークル方式（circle method）で「ラウンド順」に並べる
  // - 偶数: 1ラウンドで全員が1回出る（pairCount/2試合）
  // - 奇数: BYE(休み)を1つ入れて回す

  const n = pairCount;
  if (n < 2) return [];

  const hasBye = n % 2 === 1;
  const size = hasBye ? n + 1 : n;

  // 1..n に加えて、奇数なら BYE(=0) を追加
  const players: number[] = Array.from({ length: size }, (_, i) => (i + 1 <= n ? i + 1 : 0));

  const rounds = size - 1;
  const matches: Match[] = [];

  for (let r = 0; r < rounds; r += 1) {
    // 1ラウンド分
    for (let i = 0; i < size / 2; i += 1) {
      const a = players[i];
      const b = players[size - 1 - i];
      if (a === 0 || b === 0) continue; // BYEは除外

      // id は必ず "小さい-大きい" にして、既存キーと互換維持
      const p1 = Math.min(a, b);
      const p2 = Math.max(a, b);

      matches.push({
        id: `${p1}-${p2}`,
        pairA: p1,
        pairB: p2,
      });
    }

    // rotation（先頭固定で残りを回す）
    // [固定, ...rest] の rest を右回転
    const fixed = players[0];
    const rest = players.slice(1);
    rest.unshift(rest.pop() as number);
    players.splice(0, players.length, fixed, ...rest);
  }

  return matches;
};


const leagueKey = (leagueId: LeagueId) => `${STORAGE_NAMESPACE}:${leagueId}`;

const loadLegacyState = (): LegacyStoredState | null => {
  try {
    const stored = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!stored) {
      return null;
    }
    const parsed = JSON.parse(stored) as LegacyStoredState;
    if (!parsed || typeof parsed.pairCount !== 'number') {
      return null;
    }
    return {
      pairCount: parsed.pairCount,
      completedIds: Array.isArray(parsed.completedIds)
        ? parsed.completedIds.filter((id) => typeof id === 'string')
        : [],
    };
  } catch {
    return null;
  }
};

const loadLeagueState = (leagueId: LeagueId): LeagueState => {
  if (typeof window === 'undefined') {
    return defaultLeagueState;
  }

  try {
    const stored = window.localStorage.getItem(leagueKey(leagueId));
    if (!stored) {
      if (leagueId === 'A') {
        const legacy = loadLegacyState();
        if (legacy) {
          return {
            pairCount: legacy.pairCount,
            completedMap: Object.fromEntries(legacy.completedIds.map((id) => [id, true])),
          };
        }
      }
      return defaultLeagueState;
    }
    const parsed = JSON.parse(stored) as LeagueState;
    if (!parsed || typeof parsed.pairCount !== 'number') {
      return defaultLeagueState;
    }
    return {
      pairCount: parsed.pairCount,
      completedMap:
        parsed.completedMap && typeof parsed.completedMap === 'object'
          ? parsed.completedMap
          : {},
    };
  } catch {
    return defaultLeagueState;
  }
};

const App = () => {
  const [activeLeague, setActiveLeague] = useState<LeagueId>(() => {
    if (typeof window === 'undefined') {
      return 'A';
    }
    const stored = window.localStorage.getItem(ACTIVE_LEAGUE_KEY);
return LEAGUES.includes(stored as LeagueId) ? (stored as LeagueId) : 'A';
  });
const [leagues, setLeagues] = useState<Record<LeagueId, LeagueState>>(() => {
  return Object.fromEntries(LEAGUES.map((id) => [id, loadLeagueState(id)])) as Record<
    LeagueId,
    LeagueState
  >;
});

  const currentLeague = leagues[activeLeague];
  const matches = useMemo(
    () => generateMatches(currentLeague.pairCount),
    [currentLeague.pairCount],
  );

  useEffect(() => {
  const run = async () => {
    const pairCount = await loadPairCount(activeLeague);
    if (pairCount == null) return;

    setLeagues((prev) => ({
      ...prev,
      [activeLeague]: {
        ...prev[activeLeague],
        pairCount,
      },
    }));
  };

  run();
}, [activeLeague]);

useEffect(() => {
  let cancelled = false;

  const loadFromSupabase = async () => {
    const { data, error } = await supabase
      .from('matches')
      .select('league, match_key, completed')
      .eq('league', activeLeague);

    if (cancelled) return;

    if (error) {
      console.error('Supabase load error:', error);
      return;
    }

    setLeagues((prev) => {
      const pairCount = prev[activeLeague].pairCount;
      const allowed = new Set(generateMatches(pairCount).map((m) => m.id));

      const completedMap: Record<string, boolean> = {};
      for (const row of (data ?? []) as MatchRow[]) {
        if (!allowed.has(row.match_key)) continue;
        completedMap[row.match_key] = !!row.completed;
      }

      return {
        ...prev,
        [activeLeague]: {
          ...prev[activeLeague],
          completedMap,
        },
      };
    });
  };

  loadFromSupabase();

  return () => {
    cancelled = true;
  };
}, [activeLeague]);




useEffect(() => {
  const channel = supabase
    .channel(`realtime:league_settings:${activeLeague}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'league_settings',
      },
      (payload) => {
        const row = (payload.new ?? payload.old) as unknown as {
          league: LeagueId;
          pair_count: number;
        };

        if (!row?.league) return;
        if (row.league !== activeLeague) return;


        setLeagues((prev) => ({
          ...prev,
          [activeLeague]: {
            ...prev[activeLeague],
            pairCount: row.pair_count,
          },
        }));
      },
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}, [activeLeague]);

useEffect(() => {
  const channel = supabase
    .channel(`realtime:matches:${activeLeague}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'matches',
      },
      (payload) => {
        const row = (payload.new ?? payload.old) as unknown as MatchRow;
        if (!row?.match_key) return;
        if (row.league !== activeLeague) return;

        setLeagues((prev) => {
          const pairCount = prev[activeLeague].pairCount;
          const allowed = new Set(generateMatches(pairCount).map((m) => m.id));
          if (!allowed.has(row.match_key)) return prev;

          return {
            ...prev,
            [activeLeague]: {
              ...prev[activeLeague],
              completedMap: {
                ...prev[activeLeague].completedMap,
                [row.match_key]: !!row.completed,
              },
            },
          };
        });
      },
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}, [activeLeague]);




  useEffect(() => {
    const matchIds = new Set(matches.map((match) => match.id));
    setLeagues((prev) => ({
      ...prev,
      [activeLeague]: {
        ...prev[activeLeague],
        completedMap: Object.fromEntries(
          Object.entries(prev[activeLeague].completedMap).filter(([id]) => matchIds.has(id)),
        ),
      },
    }));
  }, [matches, activeLeague]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
LEAGUES.forEach((leagueId) => {
  window.localStorage.setItem(leagueKey(leagueId), JSON.stringify(leagues[leagueId]));
});

    window.localStorage.setItem(ACTIVE_LEAGUE_KEY, activeLeague);
  }, [leagues, activeLeague]);

  const completedIds = Object.keys(currentLeague.completedMap).filter(
    (id) => currentLeague.completedMap[id],
  );

  const totalMatches = matches.length;
  const completedCount = completedIds.length;
  const canEditPairCount = completedCount === 0;
  const progress = totalMatches === 0 ? 0 : Math.round((completedCount / totalMatches) * 100);

const saveCompleted = async (league: LeagueId, matchKey: string, completed: boolean) => {
  console.log('[saveCompleted] start', { league, matchKey, completed });

  const { error } = await supabase
    .from('matches')
    .upsert(
      { league, match_key: matchKey, completed },
      { onConflict: 'league,match_key' },
    );

  if (error) {
    console.error('Supabase save error:', error);
  }
};

const loadPairCount = async (league: LeagueId) => {
  const { data, error } = await supabase
    .from('league_settings')
    .select('pair_count')
    .eq('league', league)
    .single();

  if (error) {
    console.error('Supabase load pair_count error:', error);
    return null;
  }
  return data?.pair_count ?? null;
};

const savePairCount = async (league: LeagueId, pairCount: number) => {
  const { error } = await supabase
    .from('league_settings')
    .upsert({ league, pair_count: pairCount }, { onConflict: 'league' });

  if (error) {
    console.error('Supabase save pair_count error:', error);
  }
};

const handleToggle = async (id: string) => {
  console.log('[handleToggle] clicked', { id, activeLeague }); // ★これ追加
  const next = !currentLeague.completedMap[id];

  // 画面は即時反映（楽観更新）
  setLeagues((prev) => {
    const current = prev[activeLeague];
    return {
      ...prev,
      [activeLeague]: {
        ...current,
        completedMap: {
          ...current.completedMap,
          [id]: !current.completedMap[id],
        },
      },
    };
  });

  // DBへ保存
  await saveCompleted(activeLeague, id, next);
};

const handleLeagueChange = (leagueId: LeagueId) => {
  console.log('[handleLeagueChange]', leagueId);
  setActiveLeague(leagueId);
};

const resetLeagueInSupabase = async (league: LeagueId, pairCount: number) => {
  const matchRows = generateMatches(pairCount).map((m) => ({
    league,
    match_key: m.id,
    completed: false,
  }));

  const { error } = await supabase
    .from('matches')
    .upsert(matchRows, { onConflict: 'league,match_key' });

  if (error) {
    console.error('Supabase reset error:', error);
  }
};


const handleResetLeague = async () => {
  const pairCount = leagues[activeLeague].pairCount;

  // ① 画面は即時反映（先に消す）
  setLeagues((prev) => ({
    ...prev,
    [activeLeague]: {
      ...prev[activeLeague],
      completedMap: {},
    },
  }));

  // ② DB もリセット（同じ pairCount を使う）
  await resetLeagueInSupabase(activeLeague, pairCount);
};


const handleStepperChange = async (delta: number) => {
  // チェックが1つでもある場合は変更不可
  if (!canEditPairCount) return;

  const next = Math.min(
    MAX_PAIR_COUNT,
    Math.max(MIN_PAIR_COUNT, currentLeague.pairCount + delta),
  );

  // ① 画面を即時更新
  setLeagues((prev) => ({
    ...prev,
    [activeLeague]: {
      ...prev[activeLeague],
      pairCount: next,
    },
  }));

  // ② Supabase に保存（←これが同期の肝）
  await savePairCount(activeLeague, next);
};


  return (
    <div className="app">
      <nav className="league-tabs">
{LEAGUES.map((leagueId) => (
          <button
            key={leagueId}
            type="button"
            className={`league-tabs__button ${
              activeLeague === leagueId ? 'league-tabs__button--active' : ''
            }`}
            onClick={() => handleLeagueChange(leagueId)}
          >
            リーグ{leagueId}
          </button>
        ))}
      </nav>
      <header className="app__header">
        <div>
          <p className="app__eyebrow">テニス練習会</p>
          <h1>試合進行表</h1>
          <p className="app__description">
            ペア数を入力すると総当たりの対戦表が自動生成されます。完了した試合をチェックして進捗を確認できます。
          </p>
          <div className="league-badge">現在のリーグ: リーグ{activeLeague}</div>
          <button
            type="button"
            className="reset-button"
            onClick={handleResetLeague}
            disabled={completedCount === 0}
          >
            このリーグをリセット
          </button>
        </div>
        <div className="input-card">
          <label htmlFor="pairCount">ペア数</label>
          <div className="input-stepper">
<input
  id="pairCount"
  type="number"
  min={MIN_PAIR_COUNT}
  max={MAX_PAIR_COUNT}
  value={currentLeague.pairCount}
  readOnly        // ★入力不可
  disabled        // ★フォーカスも不可（矢印操作のみ）
            />
            <div className="input-stepper__buttons">
              <button
                type="button"
                className="input-stepper__button"
                onClick={() => handleStepperChange(1)}
                aria-label="ペア数を増やす"
disabled={!canEditPairCount || currentLeague.pairCount >= MAX_PAIR_COUNT}
              >
                +
              </button>
              <button
                type="button"
                className="input-stepper__button"
                onClick={() => handleStepperChange(-1)}
                aria-label="ペア数を減らす"
disabled={!canEditPairCount || currentLeague.pairCount <= MIN_PAIR_COUNT}
              >
                −
              </button>
            </div>
          </div>
          <p className="input-help">
            {canEditPairCount
    ? '2以上の整数を入力してください'
    : 'ペア数を変更するには、このリーグをリセットするか、チェックを全て外してください'}</p>
        </div>
      </header>

      <section className="progress">
        <div className="progress__header">
          <span>
            完了数 {completedCount} / {totalMatches}
          </span>
          <span>{progress}%</span>
        </div>
        <div className="progress__bar">
          <div className="progress__fill" style={{ width: `${progress}%` }} />
        </div>
      </section>

      <section className="matches">
        {matches.length === 0 ? (
          <p className="matches__empty">ペア数を増やすと試合が表示されます。</p>
        ) : (
          <ul className="matches__list">
            {matches.map((match, index) => {
              const isCompleted = completedIds.includes(match.id);
              return (
                <li
                  key={match.id}
                  className={`matches__item ${isCompleted ? 'matches__item--completed' : ''}`}
                >
                  <label className="matches__label">
                    <input
                      type="checkbox"
                      checked={isCompleted}
                      onChange={() => handleToggle(match.id)}
                    />
                    <span>
                      {index + 1}. ペア{match.pairA} vs ペア{match.pairB}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
};

export default App;
