import { useEffect, useMemo, useState } from 'react';
import { supabase } from './lib/supabase'
import './App.css';

const STORAGE_NAMESPACE = 'tennisMatchApp:league';
const ACTIVE_LEAGUE_KEY = 'tennisMatchApp:activeLeague';
const LEGACY_STORAGE_KEY = 'tennis-match-progress';

type LeagueId = 'A' | 'B';

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


const defaultLeagueState: LeagueState = {
  pairCount: 4,
  completedMap: {},
};

const generateMatches = (pairCount: number): Match[] => {
  const matches: Match[] = [];
  for (let i = 1; i <= pairCount; i += 1) {
    for (let j = i + 1; j <= pairCount; j += 1) {
      matches.push({
        id: `${i}-${j}`,
        pairA: i,
        pairB: j,
      });
    }
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
    return stored === 'B' ? 'B' : 'A';
  });
  const [leagues, setLeagues] = useState<Record<LeagueId, LeagueState>>(() => ({
    A: loadLeagueState('A'),
    B: loadLeagueState('B'),
  }));

  const currentLeague = leagues[activeLeague];
  const matches = useMemo(
    () => generateMatches(currentLeague.pairCount),
    [currentLeague.pairCount],
  );

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
    .channel(`realtime:matches:${activeLeague}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'matches',
        filter: `league=eq.${activeLeague}`,
      },
      (payload) => {
        const row = (payload.new ?? payload.old) as unknown as MatchRow;
        if (!row?.match_key) return;

        setLeagues((prev) => {
          const pairCount = prev[activeLeague].pairCount;
          const allowed = new Set(generateMatches(pairCount).map((m) => m.id));
          if (!allowed.has(row.match_key)) return prev; // 今の表示対象外は無視

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
    (['A', 'B'] as LeagueId[]).forEach((leagueId) => {
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


  const handlePairCountChange = (value: string) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return;
    }
    const bounded = Math.max(2, Math.floor(parsed));
    setLeagues((prev) => ({
      ...prev,
      [activeLeague]: {
        ...prev[activeLeague],
        pairCount: bounded,
      },
    }));
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


  const handleLeagueChange = (leagueId: LeagueId) => {
    setActiveLeague(leagueId);
  };

  const handleStepperChange = (delta: number) => {
    setLeagues((prev) => ({
      ...prev,
      [activeLeague]: {
        ...prev[activeLeague],
        pairCount: Math.max(2, prev[activeLeague].pairCount + delta),
      },
    }));
  };

  return (
    <div className="app">
      <nav className="league-tabs">
        {(['A', 'B'] as LeagueId[]).map((leagueId) => (
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
              min={2}
              value={currentLeague.pairCount}
              onChange={(event) => handlePairCountChange(event.target.value)}
              disabled={!canEditPairCount}
            />
            <div className="input-stepper__buttons">
              <button
                type="button"
                className="input-stepper__button"
                onClick={() => handleStepperChange(1)}
                aria-label="ペア数を増やす"
                disabled={!canEditPairCount}
              >
                +
              </button>
              <button
                type="button"
                className="input-stepper__button"
                onClick={() => handleStepperChange(-1)}
                aria-label="ペア数を減らす"
                disabled={!canEditPairCount}
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
