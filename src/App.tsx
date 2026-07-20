import { useEffect, useMemo, useState } from 'react';
import { supabase } from './lib/supabase'
import './App.css';

const STORAGE_NAMESPACE = 'tennisMatchApp:league';
const ACTIVE_LEAGUE_KEY = 'tennisMatchApp:activeLeague';
const LEGACY_STORAGE_KEY = 'tennis-match-progress';

type LeagueId = 'A' | 'B' | 'C' | 'D' | 'E';
const LEAGUES: LeagueId[] = ['A', 'B', 'C', 'D', 'E'];

const MIN_PAIR_COUNT = 2;
const MAX_PAIR_COUNT = 100;
const MIN_COURT_COUNT = 1;
const MAX_COURT_COUNT = 6;

// 1試合の想定時間（表示上の目安にのみ使用）
const TICK_MS = 30_000;

type MatchState = {
  completed: boolean;
  courtNo: number | null;
  startedAt: string | null;
  finishedAt: string | null;
};

type LeagueState = {
  pairCount: number;
  courtCount: number;
  inactivePairs: number[];
  matches: Record<string, MatchState>;
};

type MatchRow = {
  league: LeagueId;
  match_key: string;
  completed: boolean;
  court_no: number | null;
  started_at: string | null;
  finished_at: string | null;
};

type LegacyStoredState = {
  pairCount: number;
  completedIds: string[];
};

const defaultLeagueState: LeagueState = {
  pairCount: 4,
  courtCount: 1,
  inactivePairs: [],
  matches: {},
};

/* =========================================================
   match_key ユーティリティ（"小-大" 形式を維持する）
   ========================================================= */

const matchKeyOf = (a: number, b: number) => `${Math.min(a, b)}-${Math.max(a, b)}`;

const parseMatchKey = (key: string): [number, number] | null => {
  const parts = key.split('-');
  if (parts.length !== 2) return null;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
  if (a < 1 || b < 1 || a >= b) return null;
  return [a, b];
};

const emptyMatchState = (): MatchState => ({
  completed: false,
  courtNo: null,
  startedAt: null,
  finishedAt: null,
});

const rowToMatchState = (row: MatchRow): MatchState => ({
  completed: !!row.completed,
  courtNo: row.court_no ?? null,
  startedAt: row.started_at ?? null,
  finishedAt: row.finished_at ?? null,
});

const clampCourtCount = (value: unknown): number => {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : MIN_COURT_COUNT;
  return Math.min(MAX_COURT_COUNT, Math.max(MIN_COURT_COUNT, n));
};

const normalizeInactivePairs = (value: unknown): number[] => {
  if (!Array.isArray(value)) return [];
  const out = value
    .map((v) => Number(v))
    .filter((v) => Number.isInteger(v) && v >= 1);
  return Array.from(new Set(out)).sort((a, b) => a - b);
};

/* =========================================================
   盤面の集計（進行中・消化数・最終終了時刻）

   Object.entries の列挙順に依存しない集計のみを行う
   （加算と最大値なので順序非依存）。
   ========================================================= */

type CourtOccupant = {
  matchKey: string;
  pairA: number;
  pairB: number;
  startedAt: string | null;
};

type Board = {
  games: number[]; // ペア番号 → 消化した（completed=true の）試合数
  lastEnd: (number | null)[]; // ペア番号 → 最後に試合を終えた時刻(epoch ms)。未出場は null
  playingCourtOf: Map<number, number>; // ペア番号 → 出場中のコート番号
  courtOccupant: Map<number, CourtOccupant>; // コート番号 → 進行中の試合
  completedCount: number;
};

const buildBoard = (state: LeagueState): Board => {
  const size = state.pairCount + 1;
  const games = new Array<number>(size).fill(0);
  const lastEnd = new Array<number | null>(size).fill(null);
  const playingCourtOf = new Map<number, number>();
  const courtOccupant = new Map<number, CourtOccupant>();
  let completedCount = 0;

  for (const [key, m] of Object.entries(state.matches)) {
    const parsed = parseMatchKey(key);
    if (!parsed) continue;
    const [a, b] = parsed;
    if (b > state.pairCount) continue; // ペア数を減らした場合の残骸を無視

    if (m.completed) {
      completedCount += 1;
      games[a] += 1;
      games[b] += 1;
      const t = m.finishedAt ? Date.parse(m.finishedAt) : NaN;
      if (!Number.isNaN(t)) {
        if (lastEnd[a] === null || t > (lastEnd[a] as number)) lastEnd[a] = t;
        if (lastEnd[b] === null || t > (lastEnd[b] as number)) lastEnd[b] = t;
      }
    } else if (m.courtNo !== null) {
      playingCourtOf.set(a, m.courtNo);
      playingCourtOf.set(b, m.courtNo);
      courtOccupant.set(m.courtNo, { matchKey: key, pairA: a, pairB: b, startedAt: m.startedAt });
    }
  }

  return { games, lastEnd, playingCourtOf, courtOccupant, completedCount };
};

/* =========================================================
   提案アルゴリズム

   完全に決定的。now() を使わず finished_at の順序のみで判定するため、
   全端末が同じ提案を出す。
   ========================================================= */

type Suggestion =
  | { kind: 'suggestion'; courtNo: number; pairA: number; pairB: number }
  | { kind: 'no-candidates'; courtNo: number }
  | { kind: 'all-played'; courtNo: number };

// 消化試合数 昇順 → 最後に終えたのが古い順(未出場が最優先) → ペア番号 昇順
const compareCandidates = (p: number, q: number, board: Board): number => {
  if (board.games[p] !== board.games[q]) return board.games[p] - board.games[q];
  const lp = board.lastEnd[p];
  const lq = board.lastEnd[q];
  if (lp !== lq) {
    if (lp === null) return -1;
    if (lq === null) return 1;
    return lp - lq;
  }
  return p - q;
};

// a と b がこれから対戦可能か（未消化かつ進行中でない）
const isPlayable = (state: LeagueState, a: number, b: number): boolean => {
  const st = state.matches[matchKeyOf(a, b)];
  if (!st) return true; // 行が無い ＝ 未消化
  if (st.completed) return false;
  if (st.courtNo !== null) return false; // 進行中
  return true;
};

const suggestForCourt = (
  courtNo: number,
  state: LeagueState,
  board: Board,
  excluded: Set<number>,
): Suggestion => {
  const available: number[] = [];
  for (let p = 1; p <= state.pairCount; p += 1) {
    if (state.inactivePairs.includes(p)) continue;
    if (board.playingCourtOf.has(p)) continue;
    if (excluded.has(p)) continue;
    available.push(p);
  }

  if (available.length < 2) return { kind: 'no-candidates', courtNo };

  // ① 最も消化試合数が少ないペアをアンカーにする
  const anchors = available.slice().sort((x, y) => compareCandidates(x, y, board));

  for (const anchor of anchors) {
    // ② まだ対戦していない相手だけに絞る → ③ 同じ基準で相手を選ぶ
    const partners = available
      .filter((p) => p !== anchor && isPlayable(state, anchor, p))
      .sort((x, y) => compareCandidates(x, y, board));

    if (partners.length > 0) {
      const best = partners[0];
      return {
        kind: 'suggestion',
        courtNo,
        pairA: Math.min(anchor, best),
        pairB: Math.max(anchor, best),
      };
    }
  }

  // どのアンカーも全員と対戦済み（5ペアの日はここで完走になる）
  return { kind: 'all-played', courtNo };
};

// 空いている全コートに対して提案する。
// 同じペアを2つのコートに提案しないよう、確定した提案分を除外していく。
const suggestForFreeCourts = (state: LeagueState, board: Board): Map<number, Suggestion> => {
  const result = new Map<number, Suggestion>();
  const excluded = new Set<number>();

  for (let c = 1; c <= state.courtCount; c += 1) {
    if (board.courtOccupant.has(c)) continue;
    const s = suggestForCourt(c, state, board, excluded);
    result.set(c, s);
    if (s.kind === 'suggestion') {
      excluded.add(s.pairA);
      excluded.add(s.pairB);
    }
  }

  return result;
};

/* =========================================================
   localStorage
   ========================================================= */

const leagueKey = (leagueId: LeagueId) => `${STORAGE_NAMESPACE}:${leagueId}`;

const loadLegacyState = (): LegacyStoredState | null => {
  try {
    const stored = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as LegacyStoredState;
    if (!parsed || typeof parsed.pairCount !== 'number') return null;
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

// 旧形式（completedMap: Record<string, boolean>）を新形式に変換する
const matchesFromCompletedMap = (map: unknown): Record<string, MatchState> => {
  if (!map || typeof map !== 'object') return {};
  const out: Record<string, MatchState> = {};
  for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
    if (!parseMatchKey(key)) continue;
    out[key] = { ...emptyMatchState(), completed: !!value };
  }
  return out;
};

const normalizeMatches = (value: unknown): Record<string, MatchState> => {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, MatchState> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!parseMatchKey(key)) continue;
    if (typeof raw === 'boolean') {
      out[key] = { ...emptyMatchState(), completed: raw };
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as Partial<MatchState>;
    out[key] = {
      completed: !!m.completed,
      courtNo: typeof m.courtNo === 'number' ? m.courtNo : null,
      startedAt: typeof m.startedAt === 'string' ? m.startedAt : null,
      finishedAt: typeof m.finishedAt === 'string' ? m.finishedAt : null,
    };
  }
  return out;
};

const loadLeagueState = (leagueId: LeagueId): LeagueState => {
  if (typeof window === 'undefined') return defaultLeagueState;

  try {
    const stored = window.localStorage.getItem(leagueKey(leagueId));
    if (!stored) {
      if (leagueId === 'A') {
        const legacy = loadLegacyState();
        if (legacy) {
          return {
            pairCount: legacy.pairCount,
            courtCount: MIN_COURT_COUNT,
            inactivePairs: [],
            matches: Object.fromEntries(
              legacy.completedIds
                .filter((id) => parseMatchKey(id))
                .map((id) => [id, { ...emptyMatchState(), completed: true }]),
            ),
          };
        }
      }
      return defaultLeagueState;
    }

    const parsed = JSON.parse(stored) as Partial<LeagueState> & { completedMap?: unknown };
    if (!parsed || typeof parsed.pairCount !== 'number') return defaultLeagueState;

    return {
      pairCount: parsed.pairCount,
      courtCount: clampCourtCount(parsed.courtCount),
      inactivePairs: normalizeInactivePairs(parsed.inactivePairs),
      // 旧形式（completedMap）からの移行に対応
      matches: parsed.matches
        ? normalizeMatches(parsed.matches)
        : matchesFromCompletedMap(parsed.completedMap),
    };
  } catch {
    return defaultLeagueState;
  }
};

/* =========================================================
   Supabase
   ========================================================= */

const fetchMatches = async (league: LeagueId) => {
  const { data, error } = await supabase
    .from('matches')
    .select('league, match_key, completed, court_no, started_at, finished_at')
    .eq('league', league);

  if (error) {
    console.error('Supabase load matches error:', error);
    return null;
  }
  return (data ?? []) as MatchRow[];
};

const loadLeagueSettings = async (league: LeagueId) => {
  const { data, error } = await supabase
    .from('league_settings')
    .select('pair_count, court_count, inactive_pairs')
    .eq('league', league)
    .single();

  if (!error && data) {
    return {
      pairCount: data.pair_count ?? null,
      courtCount: clampCourtCount(data.court_count),
      inactivePairs: normalizeInactivePairs(data.inactive_pairs),
    };
  }

  // マイグレーション未実行の環境では上の select が失敗する。
  // その場合でも pair_count の同期だけは維持する。
  const fallback = await supabase
    .from('league_settings')
    .select('pair_count')
    .eq('league', league)
    .single();

  if (fallback.error) {
    console.error('Supabase load league_settings error:', fallback.error);
    return null;
  }

  return {
    pairCount: fallback.data?.pair_count ?? null,
    courtCount: MIN_COURT_COUNT,
    inactivePairs: [] as number[],
  };
};

const saveLeagueSettings = async (
  league: LeagueId,
  pairCount: number,
  courtCount: number,
  inactivePairs: number[],
) => {
  const { error } = await supabase
    .from('league_settings')
    .upsert(
      { league, pair_count: pairCount, court_count: courtCount, inactive_pairs: inactivePairs },
      { onConflict: 'league' },
    );

  if (!error) return;

  const fallback = await supabase
    .from('league_settings')
    .upsert({ league, pair_count: pairCount }, { onConflict: 'league' });

  if (fallback.error) {
    console.error('Supabase save league_settings error:', fallback.error);
  }
};

// 進行中の試合はすべて RPC 経由。サーバー側の now() と
// アドバイザリロックで、時計ズレと二重投入の両方を防ぐ。
const rpcText = async (fn: string, args: Record<string, unknown>): Promise<string> => {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    console.error(`Supabase rpc ${fn} error:`, error);
    return 'error';
  }
  return typeof data === 'string' ? data : 'error';
};

const startMatchRpc = (league: LeagueId, matchKey: string, courtNo: number) =>
  rpcText('start_match', { p_league: league, p_match_key: matchKey, p_court_no: courtNo });

const finishMatchRpc = (league: LeagueId, matchKey: string) =>
  rpcText('finish_match', { p_league: league, p_match_key: matchKey });

const cancelMatchRpc = (league: LeagueId, matchKey: string) =>
  rpcText('cancel_match', { p_league: league, p_match_key: matchKey });

const RPC_MESSAGES: Record<string, string> = {
  court_busy: '他の端末が先にこのコートを埋めました。提案を出し直します。',
  pair_busy: '選んだペアが別のコートで試合中です。提案を出し直します。',
  already_completed: 'この試合はすでに消化済みです。',
  not_found: 'この試合は進行中ではありません。',
  error: '通信に失敗しました。画面を最新化します。',
};

/* =========================================================
   表示ヘルパー
   ========================================================= */

const formatMinutes = (fromIso: string | null, now: number): string => {
  if (!fromIso) return '';
  const t = Date.parse(fromIso);
  if (Number.isNaN(t)) return '';
  const min = Math.max(0, Math.floor((now - t) / 60_000));
  return `${min}分`;
};

const App = () => {
  const [activeLeague, setActiveLeague] = useState<LeagueId>(() => {
    if (typeof window === 'undefined') return 'A';
    const stored = window.localStorage.getItem(ACTIVE_LEAGUE_KEY);
    return LEAGUES.includes(stored as LeagueId) ? (stored as LeagueId) : 'A';
  });

  const [leagues, setLeagues] = useState<Record<LeagueId, LeagueState>>(() => {
    return Object.fromEntries(LEAGUES.map((id) => [id, loadLeagueState(id)])) as Record<
      LeagueId,
      LeagueState
    >;
  });

  const [notice, setNotice] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ courtNo: number; first: number | null } | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());

  const currentLeague = leagues[activeLeague];
  const board = useMemo(() => buildBoard(currentLeague), [currentLeague]);
  const suggestions = useMemo(
    () => suggestForFreeCourts(currentLeague, board),
    [currentLeague, board],
  );

  // 経過時間・休憩時間の表示更新のみ（判定ロジックには使わない）
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const applyMatchRows = (league: LeagueId, rows: MatchRow[]) => {
    setLeagues((prev) => {
      const pairCount = prev[league].pairCount;
      const matches: Record<string, MatchState> = {};
      for (const row of rows) {
        const parsed = parseMatchKey(row.match_key);
        if (!parsed || parsed[1] > pairCount) continue;
        matches[row.match_key] = rowToMatchState(row);
      }
      return { ...prev, [league]: { ...prev[league], matches } };
    });
  };

  const reloadMatches = async (league: LeagueId) => {
    const rows = await fetchMatches(league);
    if (rows) applyMatchRows(league, rows);
  };

  useEffect(() => {
    const run = async () => {
      const settings = await loadLeagueSettings(activeLeague);
      if (settings == null) return;
      setLeagues((prev) => ({
        ...prev,
        [activeLeague]: {
          ...prev[activeLeague],
          pairCount: settings.pairCount ?? prev[activeLeague].pairCount,
          courtCount: settings.courtCount,
          inactivePairs: settings.inactivePairs,
        },
      }));
    };
    run();
  }, [activeLeague]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const rows = await fetchMatches(activeLeague);
      if (cancelled || !rows) return;
      applyMatchRows(activeLeague, rows);
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [activeLeague]);

  useEffect(() => {
    const channel = supabase
      .channel(`realtime:league_settings:${activeLeague}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'league_settings' },
        (payload) => {
          const row = (payload.new ?? payload.old) as unknown as {
            league: LeagueId;
            pair_count: number;
            court_count: number | null;
            inactive_pairs: unknown;
          };

          if (!row?.league) return;
          if (row.league !== activeLeague) return;

          setLeagues((prev) => ({
            ...prev,
            [activeLeague]: {
              ...prev[activeLeague],
              pairCount: row.pair_count,
              courtCount: clampCourtCount(row.court_count),
              inactivePairs: normalizeInactivePairs(row.inactive_pairs),
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matches' }, (payload) => {
        const row = (payload.new ?? payload.old) as unknown as MatchRow;
        if (!row?.match_key) return;
        if (row.league !== activeLeague) return;

        setLeagues((prev) => {
          const parsed = parseMatchKey(row.match_key);
          if (!parsed || parsed[1] > prev[activeLeague].pairCount) return prev;

          return {
            ...prev,
            [activeLeague]: {
              ...prev[activeLeague],
              matches: {
                ...prev[activeLeague].matches,
                [row.match_key]: rowToMatchState(row),
              },
            },
          };
        });
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [activeLeague]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    LEAGUES.forEach((leagueId) => {
      window.localStorage.setItem(leagueKey(leagueId), JSON.stringify(leagues[leagueId]));
    });
    window.localStorage.setItem(ACTIVE_LEAGUE_KEY, activeLeague);
  }, [leagues, activeLeague]);

  // リーグを切り替えたら選択中のピッカーは閉じる
  useEffect(() => {
    setPicker(null);
    setConfirmingReset(false);
  }, [activeLeague]);

  // 他端末がコート数を減らした場合、存在しないコートのピッカーを閉じる
  useEffect(() => {
    if (picker && picker.courtNo > currentLeague.courtCount) setPicker(null);
  }, [picker, currentLeague.courtCount]);

  /* ---------- 操作 ---------- */

  const patchMatch = (matchKey: string, next: MatchState) => {
    setLeagues((prev) => ({
      ...prev,
      [activeLeague]: {
        ...prev[activeLeague],
        matches: { ...prev[activeLeague].matches, [matchKey]: next },
      },
    }));
  };

  const handleStart = async (courtNo: number, a: number, b: number) => {
    const key = matchKeyOf(a, b);
    setPicker(null);

    // 楽観更新（started_at は表示用。確定値はサーバーの now() で上書きされる）
    patchMatch(key, {
      completed: false,
      courtNo,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    });

    const result = await startMatchRpc(activeLeague, key, courtNo);
    if (result !== 'ok') {
      setNotice(RPC_MESSAGES[result] ?? '試合を開始できませんでした。');
      await reloadMatches(activeLeague);
    }
  };

  const handleFinish = async (matchKey: string) => {
    const prevState = currentLeague.matches[matchKey];
    patchMatch(matchKey, {
      completed: true,
      courtNo: prevState?.courtNo ?? null,
      startedAt: prevState?.startedAt ?? null,
      finishedAt: new Date().toISOString(),
    });

    const result = await finishMatchRpc(activeLeague, matchKey);
    if (result !== 'ok') {
      setNotice(RPC_MESSAGES[result] ?? '試合を終了できませんでした。');
      await reloadMatches(activeLeague);
    }
  };

  // 「なかったことにする」：完了にはせず未消化へ戻す
  const handleCancel = async (matchKey: string) => {
    patchMatch(matchKey, emptyMatchState());

    const result = await cancelMatchRpc(activeLeague, matchKey);
    if (result !== 'ok') {
      setNotice(RPC_MESSAGES[result] ?? '試合を取り消せませんでした。');
      await reloadMatches(activeLeague);
    }
  };

  const handleTogglePair = async (pair: number) => {
    // 試合中のペアを休止にすると進行中の試合と整合が崩れるためブロックする
    if (board.playingCourtOf.has(pair)) {
      setNotice(
        `ペア${pair}は試合中です。先に「試合終了」か「試合を取り消す」を行ってください。`,
      );
      return;
    }

    const isInactive = currentLeague.inactivePairs.includes(pair);
    const next = isInactive
      ? currentLeague.inactivePairs.filter((p) => p !== pair)
      : [...currentLeague.inactivePairs, pair].sort((a, b) => a - b);

    setLeagues((prev) => ({
      ...prev,
      [activeLeague]: { ...prev[activeLeague], inactivePairs: next },
    }));

    await saveLeagueSettings(
      activeLeague,
      currentLeague.pairCount,
      currentLeague.courtCount,
      next,
    );
  };

  const handleLeagueChange = (leagueId: LeagueId) => setActiveLeague(leagueId);

  // 練習会の開始＝記録の全消去
  const handleStartSession = async () => {
    setConfirmingReset(false);
    setPicker(null);

    setLeagues((prev) => ({
      ...prev,
      [activeLeague]: { ...prev[activeLeague], inactivePairs: [], matches: {} },
    }));

    const { error } = await supabase
      .from('matches')
      .update({ completed: false, court_no: null, started_at: null, finished_at: null })
      .eq('league', activeLeague);

    if (error) {
      console.error('Supabase reset error:', error);
      setNotice('リセットに失敗しました。');
    }

    await saveLeagueSettings(activeLeague, currentLeague.pairCount, currentLeague.courtCount, []);
    await reloadMatches(activeLeague);
  };

  // 記録のあるペア番号の最大値（ペア数を減らせる下限の判定に使う）
  const highestRecordedPair = useMemo(() => {
    let highest = 0;
    for (const [key, m] of Object.entries(currentLeague.matches)) {
      if (!m.completed && m.courtNo === null) continue;
      const parsed = parseMatchKey(key);
      if (!parsed) continue;
      if (parsed[1] > highest) highest = parsed[1];
    }
    return highest;
  }, [currentLeague.matches]);

  const minAllowedPairCount = Math.max(MIN_PAIR_COUNT, highestRecordedPair);

  const handlePairStepper = async (delta: number) => {
    const raw = currentLeague.pairCount + delta;
    // 増やす方向は常に許可（途中参加）。減らす方向は記録のあるペアを消さない範囲のみ。
    const next = Math.min(MAX_PAIR_COUNT, Math.max(minAllowedPairCount, raw));
    if (next === currentLeague.pairCount) {
      if (delta < 0 && raw < minAllowedPairCount) {
        setNotice(`ペア${minAllowedPairCount}には記録があるため、これ以上減らせません。`);
      }
      return;
    }

    setLeagues((prev) => ({
      ...prev,
      [activeLeague]: { ...prev[activeLeague], pairCount: next },
    }));

    await saveLeagueSettings(
      activeLeague,
      next,
      currentLeague.courtCount,
      currentLeague.inactivePairs,
    );
  };

  const handleCourtStepper = async (delta: number) => {
    const next = Math.min(
      MAX_COURT_COUNT,
      Math.max(MIN_COURT_COUNT, currentLeague.courtCount + delta),
    );
    if (next === currentLeague.courtCount) return;

    // 減らそうとしたコートで試合中なら止める
    if (next < currentLeague.courtCount) {
      for (let c = next + 1; c <= currentLeague.courtCount; c += 1) {
        if (board.courtOccupant.has(c)) {
          setNotice(`コート${c}は試合中です。終了か取り消しをしてから減らしてください。`);
          return;
        }
      }
    }

    setLeagues((prev) => ({
      ...prev,
      [activeLeague]: { ...prev[activeLeague], courtCount: next },
    }));

    await saveLeagueSettings(
      activeLeague,
      currentLeague.pairCount,
      next,
      currentLeague.inactivePairs,
    );
  };

  /* ---------- 表示用の派生値 ---------- */

  const courts = Array.from({ length: currentLeague.courtCount }, (_, i) => i + 1);
  const allPairs = Array.from({ length: currentLeague.pairCount }, (_, i) => i + 1);
  const totalMatches = (currentLeague.pairCount * (currentLeague.pairCount - 1)) / 2;

  const pairStatusLabel = (pair: number): string => {
    if (board.playingCourtOf.has(pair)) return `コート${board.playingCourtOf.get(pair)}`;
    if (currentLeague.inactivePairs.includes(pair)) return '休止中';
    const last = board.lastEnd[pair];
    if (last === null) return '未出場';
    return `休${formatMinutes(new Date(last).toISOString(), now)}`;
  };

  const pickerPairs = picker
    ? allPairs.filter(
        (p) => !board.playingCourtOf.has(p) && !currentLeague.inactivePairs.includes(p),
      )
    : [];

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

      {notice && <div className="notice">{notice}</div>}

      <header className="app__header">
        <div className="settings">
          <div className="settings__row">
            <span className="settings__label">ペア数</span>
            <div className="settings__stepper">
              <button
                type="button"
                className="input-stepper__button"
                onClick={() => handlePairStepper(-1)}
                aria-label="ペア数を減らす"
                disabled={currentLeague.pairCount <= minAllowedPairCount}
              >
                −
              </button>
              <span className="settings__value">{currentLeague.pairCount}</span>
              <button
                type="button"
                className="input-stepper__button"
                onClick={() => handlePairStepper(1)}
                aria-label="ペア数を増やす"
                disabled={currentLeague.pairCount >= MAX_PAIR_COUNT}
              >
                +
              </button>
            </div>
          </div>

          <div className="settings__row">
            <span className="settings__label">コート数</span>
            <div className="settings__stepper">
              <button
                type="button"
                className="input-stepper__button"
                onClick={() => handleCourtStepper(-1)}
                aria-label="コート数を減らす"
                disabled={currentLeague.courtCount <= MIN_COURT_COUNT}
              >
                −
              </button>
              <span className="settings__value">{currentLeague.courtCount}</span>
              <button
                type="button"
                className="input-stepper__button"
                onClick={() => handleCourtStepper(1)}
                aria-label="コート数を増やす"
                disabled={currentLeague.courtCount >= MAX_COURT_COUNT}
              >
                +
              </button>
            </div>
          </div>
        </div>

        <div className="session">
          <span className="session__count">
            本日の消化 <strong>{board.completedCount}</strong> 試合
            <span className="session__total"> / 全{totalMatches}試合</span>
          </span>
          {confirmingReset ? (
            <div className="session__confirm">
              <p>本日の記録をすべて消します。よろしいですか？</p>
              <div className="session__confirm-buttons">
                <button type="button" className="danger-button" onClick={handleStartSession}>
                  記録を消す
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => setConfirmingReset(false)}
                >
                  キャンセル
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="reset-button"
              onClick={() => setConfirmingReset(true)}
            >
              記録をリセット
            </button>
          )}
        </div>
      </header>

      {picker ? (
        <section className="picker">
          <div className="picker__head">
            <button type="button" className="ghost-button" onClick={() => setPicker(null)}>
              ← 戻る
            </button>
            <h2>コート{picker.courtNo} に入れる</h2>
          </div>

          <p className="picker__hint">
            {picker.first === null
              ? '1組目を選んでください'
              : `1組目: ペア${picker.first} → 2組目を選んでください`}
          </p>

          {pickerPairs.length < 2 ? (
            <p className="picker__empty">選べるペアがいません（試合中・休止中を除く）。</p>
          ) : (
            <ul className="pair-grid">
              {pickerPairs.map((pair) => {
                const isFirst = picker.first === pair;
                const played =
                  picker.first !== null && picker.first !== pair
                    ? !isPlayable(currentLeague, picker.first, pair)
                    : false;
                return (
                  <li key={pair}>
                    <button
                      type="button"
                      className={`pair-cell ${isFirst ? 'pair-cell--selected' : ''} ${
                        played ? 'pair-cell--disabled' : ''
                      }`}
                      disabled={played}
                      onClick={() => {
                        if (picker.first === null) {
                          setPicker({ ...picker, first: pair });
                        } else if (picker.first === pair) {
                          setPicker({ ...picker, first: null });
                        } else {
                          handleStart(picker.courtNo, picker.first, pair);
                        }
                      }}
                    >
                      <span className="pair-cell__name">ペア{pair}</span>
                      <span className="pair-cell__games">{board.games[pair]}試合</span>
                      <span className="pair-cell__status">
                        {played ? '対戦済み' : pairStatusLabel(pair)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : (
        <>
          <section className="courts">
            {courts.map((courtNo) => {
              const occupant = board.courtOccupant.get(courtNo);

              if (occupant) {
                return (
                  <article key={courtNo} className="court court--busy">
                    <div className="court__head">
                      <span className="court__name">コート{courtNo}</span>
                      <span className="court__badge court__badge--busy">試合中</span>
                    </div>
                    <p className="court__match">
                      ペア{occupant.pairA} <span className="court__vs">vs</span> ペア
                      {occupant.pairB}
                    </p>
                    <p className="court__meta">経過 {formatMinutes(occupant.startedAt, now)}</p>
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => handleFinish(occupant.matchKey)}
                    >
                      試合終了
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => handleCancel(occupant.matchKey)}
                    >
                      試合を取り消す
                    </button>
                  </article>
                );
              }

              const suggestion = suggestions.get(courtNo);
              return (
                <article key={courtNo} className="court court--free">
                  <div className="court__head">
                    <span className="court__name">コート{courtNo}</span>
                    <span className="court__badge">空き</span>
                  </div>

                  {suggestion?.kind === 'suggestion' ? (
                    <>
                      <p className="court__label">おすすめ</p>
                      <p className="court__match">
                        ペア{suggestion.pairA} <span className="court__vs">vs</span> ペア
                        {suggestion.pairB}
                      </p>
                      <p className="court__meta">
                        {board.games[suggestion.pairA]}試合 / {board.games[suggestion.pairB]}試合
                        {' ・ '}
                        {pairStatusLabel(suggestion.pairA)} / {pairStatusLabel(suggestion.pairB)}
                      </p>
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() =>
                          handleStart(courtNo, suggestion.pairA, suggestion.pairB)
                        }
                      >
                        この組で開始
                      </button>
                    </>
                  ) : (
                    <p className="court__empty">
                      {suggestion?.kind === 'all-played'
                        ? '全試合終了'
                        : '出られるペアがいません'}
                    </p>
                  )}

                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => setPicker({ courtNo, first: null })}
                  >
                    別の組を選ぶ →
                  </button>
                </article>
              );
            })}
          </section>

          <section className="pairs">
            <h2 className="pairs__title">ペア別（タップで休止 / 復帰）</h2>
            <ul className="pair-grid">
              {allPairs.map((pair) => {
                const inactive = currentLeague.inactivePairs.includes(pair);
                const playing = board.playingCourtOf.has(pair);
                return (
                  <li key={pair}>
                    <button
                      type="button"
                      className={`pair-cell ${inactive ? 'pair-cell--inactive' : ''} ${
                        playing ? 'pair-cell--playing' : ''
                      }`}
                      onClick={() => handleTogglePair(pair)}
                    >
                      <span className="pair-cell__name">ペア{pair}</span>
                      <span className="pair-cell__games">{board.games[pair]}試合</span>
                      <span className="pair-cell__status">{pairStatusLabel(pair)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}
    </div>
  );
};

export default App;
