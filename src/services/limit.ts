/**
 * Run at most `n` tasks at once, queueing the rest — so a sidebar with many
 * worktrees doesn't spawn dozens of `gh` / `git` processes in the same tick.
 */
export function createLimiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (active >= n) return;
    const start = queue.shift();
    if (!start) return;
    active++;
    start();
  };
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}
