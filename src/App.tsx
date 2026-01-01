import { useEffect, useMemo, useState } from 'react';
import './App.css';

const STORAGE_KEY = 'tennis-match-progress';

type StoredState = {
  pairCount: number;
  completedIds: string[];
};

type Match = {
  id: string;
  pairA: number;
  pairB: number;
};

const defaultState: StoredState = {
  pairCount: 4,
  completedIds: [],
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

const loadState = (): StoredState => {
  if (typeof window === 'undefined') {
    return defaultState;
  }

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return defaultState;
    }
    const parsed = JSON.parse(stored) as StoredState;
    if (!parsed || typeof parsed.pairCount !== 'number') {
      return defaultState;
    }
    return {
      pairCount: parsed.pairCount,
      completedIds: Array.isArray(parsed.completedIds)
        ? parsed.completedIds.filter((id) => typeof id === 'string')
        : [],
    };
  } catch {
    return defaultState;
  }
};

const App = () => {
  const [pairCount, setPairCount] = useState(() => loadState().pairCount);
  const [completedIds, setCompletedIds] = useState<string[]>(() => loadState().completedIds);

  const matches = useMemo(() => generateMatches(pairCount), [pairCount]);

  useEffect(() => {
    const matchIds = new Set(matches.map((match) => match.id));
    setCompletedIds((prev) => prev.filter((id) => matchIds.has(id)));
  }, [matches]);

  useEffect(() => {
    const state: StoredState = {
      pairCount,
      completedIds,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [pairCount, completedIds]);

  const totalMatches = matches.length;
  const completedCount = completedIds.length;
  const progress = totalMatches === 0 ? 0 : Math.round((completedCount / totalMatches) * 100);

  const handleToggle = (id: string) => {
    setCompletedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  };

  const handlePairCountChange = (value: string) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return;
    }
    const bounded = Math.max(2, Math.floor(parsed));
    setPairCount(bounded);
  };

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <p className="app__eyebrow">テニス練習会</p>
          <h1>試合進行表</h1>
          <p className="app__description">
            ペア数を入力すると総当たりの対戦表が自動生成されます。完了した試合をチェックして進捗を確認できます。
          </p>
        </div>
        <div className="input-card">
          <label htmlFor="pairCount">ペア数</label>
          <input
            id="pairCount"
            type="number"
            min={2}
            value={pairCount}
            onChange={(event) => handlePairCountChange(event.target.value)}
          />
          <p className="input-help">2以上の整数を入力してください</p>
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
