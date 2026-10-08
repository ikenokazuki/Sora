/**
 * 並行取得の合流に締切を設ける。半数以上が終わったら graceMs だけ待ち、全体では capMs で打ち切る。
 * 間に合わなかった要素は onLate(i) の値に置き換える。打ち切った処理は止めない
 * （scrape キャッシュに残り、後続の取得が速くなる）。capMs <= 0 なら Promise.all と同じ。
 */
export async function settleWithDeadline<T>(
  tasks: Promise<T>[],
  opts: { graceMs: number; capMs: number },
  onLate: (index: number) => T,
): Promise<{ values: T[]; lateCount: number }> {
  if (tasks.length === 0) return { values: [], lateCount: 0 };
  if (opts.capMs <= 0) return { values: await Promise.all(tasks), lateCount: 0 };

  const values: (T | undefined)[] = new Array(tasks.length);
  const done: boolean[] = new Array(tasks.length).fill(false);
  const half = Math.ceil(tasks.length / 2);
  let doneCount = 0;
  const timers: ReturnType<typeof setTimeout>[] = [];

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      let lateCount = 0;
      const out = Array.from({ length: tasks.length }, (_, i) => (done[i] ? (values[i] as T) : (lateCount++, onLate(i))));
      resolve({ values: out, lateCount });
    };
    timers.push(setTimeout(finish, opts.capMs));
    tasks.forEach((task, i) => {
      task.then(
        (v) => {
          if (settled) return;
          values[i] = v;
          done[i] = true;
          if (++doneCount === tasks.length) finish();
          else if (doneCount === half) timers.push(setTimeout(finish, opts.graceMs));
        },
        (err) => {
          if (settled) return; // 締切後の失敗は握りつぶす（未処理 rejection にしない）
          settled = true;
          timers.forEach(clearTimeout);
          reject(err);
        },
      );
    });
  });
}
