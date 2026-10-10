using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;

namespace SS13.DM.Runtime
{
    /// <summary>
    /// BYOND's cooperative, single-threaded scheduler. DM procs run
    /// synchronously until they sleep; `sleep(n)` parks the whole call stack
    /// (the "thread") until world.time reaches now + n; `spawn(n)` starts a new
    /// thread at now + n. Nothing runs on the thread pool: the host drives
    /// <see cref="Tick"/> from the engine's main loop (or a probe drives
    /// <see cref="RunUntilIdle"/> with a virtual clock), and every continuation
    /// runs inline on that thread in (wake time, enqueue order).
    /// </summary>
    public static class DMTickScheduler
    {
        private static readonly PriorityQueue<Action, (float Wake, long Seq)> Queue = new();
        private static long _seq;
        private static int _ownerThread = -1;

        /// <summary>world.time, in deciseconds.</summary>
        public static float Time { get; private set; }

        /// <summary>world.tick_lag, in deciseconds.</summary>
        public static float TickLag { get; set; } = 1;

        /// <summary>Receives runtime errors that escape a DM thread (BYOND prints these as "runtime error").</summary>
        public static Action<string, Exception>? ErrorSink;

        public static int Pending => Queue.Count;

        public static void Reset()
        {
            Queue.Clear();
            _seq = 0;
            Time = 0;
            TickLag = 1;
            _ownerThread = -1;
        }

        private static void CheckThread()
        {
            var id = Environment.CurrentManagedThreadId;
            if (_ownerThread == -1) _ownerThread = id;
            else if (_ownerThread != id)
                throw new InvalidOperationException("DM code must run on the scheduler thread");
        }

        private static void Enqueue(float wake, Action action) => Queue.Enqueue(action, (wake, _seq++));

        // ===== sleep =====

        public static SleepAwaitable Sleep(DMValue deciseconds) => Sleep(deciseconds.ToNumber());

        public static SleepAwaitable Sleep(double deciseconds) => new((float)deciseconds);

        public readonly struct SleepAwaitable : ICriticalNotifyCompletion
        {
            private readonly float _delay;
            public SleepAwaitable(float delay) => _delay = delay;
            public SleepAwaitable GetAwaiter() => this;
            /// <summary>sleep(-1) only yields when the tick is overrunning; this host never overruns, so it does not yield.</summary>
            public bool IsCompleted => _delay < 0;
            public DMValue GetResult() => DMValue.Null;
            public void OnCompleted(Action continuation) => UnsafeOnCompleted(continuation);
            public void UnsafeOnCompleted(Action continuation)
            {
                CheckThread();
                Enqueue(Time + Math.Max(_delay, 0), continuation);
            }
        }

        // ===== spawn =====

        public static void Spawn(DMValue deciseconds, Func<Task> body) => Spawn(deciseconds.ToNumber(), body);

        public static void Spawn(double deciseconds, Func<Task> body)
        {
            CheckThread();
            // The spawned thread inherits the spawner's usr (an AsyncLocal).
            var context = ExecutionContext.Capture();
            Enqueue(Time + (float)Math.Max(deciseconds, 0), () =>
            {
                if (context == null) Start(body, "spawn");
                else ExecutionContext.Run(context, _ => Start(body, "spawn"), null);
            });
        }

        public static void Spawn(double deciseconds, Action body) => Spawn(deciseconds, () =>
        {
            body();
            return Task.CompletedTask;
        });

        /// <summary>spawn() used as an expression evaluates to null; the body runs later.</summary>
        public static Task<DMValue> SpawnExpr(DMValue deciseconds, Func<Task<DMValue>> body)
        {
            Spawn(deciseconds, () => (Task)body());
            return Task.FromResult(DMValue.Null);
        }

        // ===== thread roots =====

        /// <summary>Starts a new DM thread now (engine events, verbs, world/New). Returns its task.</summary>
        public static Task Start(Func<Task> body, string name)
        {
            CheckThread();
            var previous = SynchronizationContext.Current;
            SynchronizationContext.SetSynchronizationContext(null);
            Task task;
            try
            {
                task = body();
            }
            catch (Exception e)
            {
                task = Task.FromException(e);
            }
            finally
            {
                SynchronizationContext.SetSynchronizationContext(previous);
            }
            Observe(task, name);
            return task;
        }

        public static Task<DMValue> Run(Func<Task<DMValue>> body, string name = "call")
        {
            Task<DMValue>? result = null;
            Start(() => result = body(), name);
            return result ?? Task.FromResult(DMValue.Null);
        }

        /// <summary>Reports a thread's runtime error once it finishes (BYOND kills the thread and logs).</summary>
        public static void Observe(Task task, string name)
        {
            if (task.IsCompleted)
            {
                Report(task, name);
                return;
            }
            task.ContinueWith(t => Report(t, name), TaskContinuationOptions.ExecuteSynchronously);
        }

        private static void Report(Task task, string name)
        {
            if (!task.IsFaulted) return;
            var e = task.Exception!.InnerException ?? task.Exception;
            if (ErrorSink != null) ErrorSink(name, e);
            else Console.Error.WriteLine($"runtime error: {e.Message} (in {name})");
        }

        // ===== driving the clock =====

        /// <summary>Advances world.time by one tick and runs everything due.</summary>
        public static void Tick() => AdvanceTo(Time + TickLag);

        /// <summary>Sets world.time (never backwards) and runs everything due by then.</summary>
        public static void AdvanceTo(float time)
        {
            CheckThread();
            if (time > Time) Time = time;
            RunDue();
        }

        /// <summary>Runs every continuation whose wake time has arrived, including ones enqueued meanwhile for now.</summary>
        public static void RunDue()
        {
            var previous = SynchronizationContext.Current;
            SynchronizationContext.SetSynchronizationContext(null);
            try
            {
                while (Queue.TryPeek(out _, out var key) && key.Wake <= Time)
                {
                    var action = Queue.Dequeue();
                    action();
                }
            }
            finally
            {
                SynchronizationContext.SetSynchronizationContext(previous);
            }
        }

        /// <summary>Virtual-clock drain for engine-free runs: jumps to each wake time until idle or <paramref name="limit"/>.</summary>
        public static void RunUntilIdle(float limit = 36000)
        {
            RunDue();
            while (Queue.TryPeek(out _, out var key) && key.Wake <= limit)
                AdvanceTo(key.Wake);
        }
    }
}
