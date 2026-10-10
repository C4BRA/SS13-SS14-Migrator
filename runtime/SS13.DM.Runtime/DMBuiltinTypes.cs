using System;
using System.Threading.Tasks;

namespace SS13.DM.Runtime
{
    /// <summary>
    /// BYOND's builtin type tree with its builtin var defaults and default
    /// procs. Codebase types are declared on top of this by generated code.
    /// </summary>
    public static class DMBuiltinTypes
    {
        public const int NORTH = 1, SOUTH = 2, EAST = 4, WEST = 8;

        private static readonly Task<DMValue> NullTask = Task.FromResult(DMValue.Null);
        private static readonly Task<DMValue> TrueTask = Task.FromResult(DMValue.True);

        private static DMVarInitializer NewList => _ => Task.FromResult(DMValue.FromList(new DMList()));

        internal static void Install()
        {
            // /datum
            Var("/datum", "tag", DMValue.Null);
            Proc("/datum", "New", (_, _) => NullTask);
            Proc("/datum", "Del", (_, _) => NullTask);
            Proc("/datum", "Topic", (_, _) => NullTask);
            Proc("/datum", "Read", (_, _) => NullTask);
            Proc("/datum", "Write", (_, _) => NullTask);

            // /atom
            DMTypes.Declare("/atom", "/datum");
            Var("/atom", "name", DMValue.Null);
            Var("/atom", "desc", DMValue.Null);
            Var("/atom", "suffix", DMValue.Null);
            Var("/atom", "text", DMValue.Null);
            Var("/atom", "icon", DMValue.Null);
            Var("/atom", "icon_state", DMValue.FromString(""));
            Var("/atom", "icon_w", DMValue.FromNumber(0));
            Var("/atom", "icon_z", DMValue.FromNumber(0));
            Var("/atom", "dir", DMValue.FromNumber(SOUTH));
            Var("/atom", "loc", DMValue.Null);
            Var("/atom", "x", DMValue.FromNumber(0));
            Var("/atom", "y", DMValue.FromNumber(0));
            Var("/atom", "z", DMValue.FromNumber(0));
            Var("/atom", "density", DMValue.FromNumber(0));
            Var("/atom", "opacity", DMValue.FromNumber(0));
            Var("/atom", "invisibility", DMValue.FromNumber(0));
            Var("/atom", "luminosity", DMValue.FromNumber(0));
            Var("/atom", "infra_luminosity", DMValue.FromNumber(0));
            Var("/atom", "layer", DMValue.FromNumber(1));
            Var("/atom", "plane", DMValue.FromNumber(0));
            Var("/atom", "alpha", DMValue.FromNumber(255));
            Var("/atom", "color", DMValue.Null);
            Var("/atom", "blend_mode", DMValue.FromNumber(0));
            Var("/atom", "appearance_flags", DMValue.FromNumber(0));
            Var("/atom", "mouse_opacity", DMValue.FromNumber(1));
            Var("/atom", "mouse_over_pointer", DMValue.Null);
            Var("/atom", "mouse_drag_pointer", DMValue.Null);
            Var("/atom", "mouse_drop_pointer", DMValue.Null);
            Var("/atom", "mouse_drop_zone", DMValue.FromNumber(0));
            Var("/atom", "pixel_x", DMValue.FromNumber(0));
            Var("/atom", "pixel_y", DMValue.FromNumber(0));
            Var("/atom", "pixel_w", DMValue.FromNumber(0));
            Var("/atom", "pixel_z", DMValue.FromNumber(0));
            Var("/atom", "maptext", DMValue.Null);
            Var("/atom", "maptext_width", DMValue.FromNumber(32));
            Var("/atom", "maptext_height", DMValue.FromNumber(32));
            Var("/atom", "maptext_x", DMValue.FromNumber(0));
            Var("/atom", "maptext_y", DMValue.FromNumber(0));
            Var("/atom", "transform", DMValue.Null);
            Var("/atom", "render_source", DMValue.Null);
            Var("/atom", "render_target", DMValue.Null);
            Var("/atom", "vis_flags", DMValue.FromNumber(0));
            Var("/atom", "filters", DMValue.Null);
            Init("/atom", "contents", NewList);
            Init("/atom", "overlays", NewList);
            Init("/atom", "underlays", NewList);
            Init("/atom", "verbs", NewList);
            Init("/atom", "vis_contents", NewList);
            Init("/atom", "vis_locs", NewList);
            Proc("/atom", "Enter", (_, _) => TrueTask);
            Proc("/atom", "Exit", (_, _) => TrueTask);
            Proc("/atom", "Entered", (_, _) => NullTask);
            Proc("/atom", "Exited", (_, _) => NullTask);
            Proc("/atom", "Cross", (_, _) => TrueTask);
            Proc("/atom", "Crossed", (_, _) => NullTask);
            Proc("/atom", "Uncross", (_, _) => TrueTask);
            Proc("/atom", "Uncrossed", (_, _) => NullTask);
            foreach (var mouse in new[] { "Click", "DblClick", "MouseDown", "MouseDrag", "MouseDrop", "MouseEntered", "MouseExited", "MouseMove", "MouseUp", "MouseWheel", "Stat" })
                Proc("/atom", mouse, (_, _) => NullTask);

            // /atom/movable
            DMTypes.Declare("/atom/movable", "/atom");
            Var("/atom/movable", "animate_movement", DMValue.FromNumber(1));
            Var("/atom/movable", "bound_x", DMValue.FromNumber(0));
            Var("/atom/movable", "bound_y", DMValue.FromNumber(0));
            Var("/atom/movable", "bound_width", DMValue.FromNumber(32));
            Var("/atom/movable", "bound_height", DMValue.FromNumber(32));
            Var("/atom/movable", "step_x", DMValue.FromNumber(0));
            Var("/atom/movable", "step_y", DMValue.FromNumber(0));
            Var("/atom/movable", "step_size", DMValue.FromNumber(32));
            Var("/atom/movable", "glide_size", DMValue.FromNumber(0));
            Var("/atom/movable", "screen_loc", DMValue.Null);
            Var("/atom/movable", "particles", DMValue.Null);
            Proc("/atom/movable", "Move", DMAtomProcs.Move, "NewLoc", "Dir", "step_x", "step_y");
            Proc("/atom/movable", "Bump", (_, _) => NullTask);

            DMTypes.Declare("/obj", "/atom/movable");
            Var("/obj", "layer", DMValue.FromNumber(3));

            DMTypes.Declare("/mob", "/atom/movable");
            Var("/mob", "layer", DMValue.FromNumber(4));
            Var("/mob", "density", DMValue.FromNumber(1));
            Var("/mob", "key", DMValue.Null);
            Var("/mob", "ckey", DMValue.Null);
            Var("/mob", "client", DMValue.Null);
            Var("/mob", "sight", DMValue.FromNumber(0));
            Var("/mob", "see_invisible", DMValue.FromNumber(0));
            Var("/mob", "see_in_dark", DMValue.FromNumber(2));
            Var("/mob", "see_infrared", DMValue.FromNumber(0));
            Var("/mob", "group", DMValue.Null);
            Proc("/mob", "Login", (_, _) => NullTask);
            Proc("/mob", "Logout", (_, _) => NullTask);

            DMTypes.Declare("/turf", "/atom");
            Var("/turf", "layer", DMValue.FromNumber(2));

            DMTypes.Declare("/area", "/atom");
            Var("/area", "layer", DMValue.FromNumber(1));
            Var("/area", "luminosity", DMValue.FromNumber(1));

            // Non-atom builtins.
            foreach (var path in new[] { "/list", "/client", "/world", "/image", "/icon", "/matrix", "/sound",
                                         "/regex", "/savefile", "/database", "/database/query", "/exception",
                                         "/particles", "/generator", "/callee", "/filters", "/alist", "/vector",
                                         "/pixloc", "/dm_filter" })
                DMTypes.Declare(path, "/datum");
            DMTypes.Declare("/mutable_appearance", "/image");
            DMTypes.Declare("/image/vis", "/image");
            Proc("/world", "New", (_, _) => NullTask);
            Proc("/world", "Del", (_, _) => NullTask);
            Proc("/world", "Reboot", (_, _) => NullTask);
            Proc("/world", "Error", (_, _) => NullTask);
            Proc("/world", "Topic", (_, _) => NullTask);
            Proc("/client", "New", (_, _) => NullTask);
            Proc("/client", "Del", (_, _) => NullTask);
            Proc("/client", "Topic", (_, _) => NullTask);
            DMRuntimeHelpers.InstallRegexProcs();
            InstallMatrixProcs();
            Proc("/icon", "Width", (_, _) => Task.FromResult(DMValue.FromNumber(32)));
            Proc("/icon", "Height", (_, _) => Task.FromResult(DMValue.FromNumber(32)));
            Var("/exception", "name", DMValue.Null);
            Var("/exception", "desc", DMValue.Null);
            Var("/exception", "file", DMValue.Null);
            Var("/exception", "line", DMValue.Null);
        }

        /// <summary>/matrix a-f transform procs: mutate the receiver and return it.</summary>
        private static void InstallMatrixProcs()
        {
            foreach (var (k, v) in new[] { ("a", 1), ("b", 0), ("c", 0), ("d", 0), ("e", 1), ("f", 0) })
                Var("/matrix", k, DMValue.FromNumber(v));
            static double G(DMRuntime m, string k) => m.GetVar(k).ToNumber();
            static void S(DMRuntime m, double a, double b, double c, double d, double e, double f)
            {
                m.SetVar("a", DMValue.FromNumber(a)); m.SetVar("b", DMValue.FromNumber(b)); m.SetVar("c", DMValue.FromNumber(c));
                m.SetVar("d", DMValue.FromNumber(d)); m.SetVar("e", DMValue.FromNumber(e)); m.SetVar("f", DMValue.FromNumber(f));
            }
            static Task<DMValue> Self(DMRuntime m) => Task.FromResult(DMValue.FromDatum(m));
            // BYOND matrix layout: x' = a*x + b*y + c ; y' = d*x + e*y + f.
            Proc("/matrix", "Scale", (m, a) =>
            {
                var sx = a.Length > 0 && !a[0].IsNull ? a[0].ToNumber() : 1;
                var sy = a.Length > 1 && !a[1].IsNull ? a[1].ToNumber() : sx;
                S(m, G(m, "a") * sx, G(m, "b") * sx, G(m, "c") * sx, G(m, "d") * sy, G(m, "e") * sy, G(m, "f") * sy);
                return Self(m);
            }, "x", "y");
            Proc("/matrix", "Translate", (m, a) =>
            {
                var tx = a.Length > 0 ? a[0].ToNumber() : 0;
                var ty = a.Length > 1 && !a[1].IsNull ? a[1].ToNumber() : tx;
                S(m, G(m, "a"), G(m, "b"), G(m, "c") + tx, G(m, "d"), G(m, "e"), G(m, "f") + ty);
                return Self(m);
            }, "x", "y");
            Proc("/matrix", "Turn", (m, a) =>
            {
                // Clockwise rotation by `angle` degrees (BYOND screen space, y up).
                var rad = (a.Length > 0 ? a[0].ToNumber() : 0) * Math.PI / 180.0;
                var cos = Math.Cos(rad);
                var sin = Math.Sin(rad);
                double A = G(m, "a"), B = G(m, "b"), C = G(m, "c"), D = G(m, "d"), E = G(m, "e"), F = G(m, "f");
                S(m, A * cos + D * sin, B * cos + E * sin, C * cos + F * sin, -A * sin + D * cos, -B * sin + E * cos, -C * sin + F * cos);
                return Self(m);
            }, "angle");
            Proc("/matrix", "Multiply", (m, a) =>
            {
                if (a.Length > 0 && a[0].AsDatum() is { } o)
                {
                    double A = G(m, "a"), B = G(m, "b"), C = G(m, "c"), D = G(m, "d"), E = G(m, "e"), F = G(m, "f");
                    double a2 = G(o, "a"), b2 = G(o, "b"), c2 = G(o, "c"), d2 = G(o, "d"), e2 = G(o, "e"), f2 = G(o, "f");
                    S(m, a2 * A + b2 * D, a2 * B + b2 * E, a2 * C + b2 * F + c2, d2 * A + e2 * D, d2 * B + e2 * E, d2 * C + e2 * F + f2);
                }
                else if (a.Length > 0)
                {
                    var k = a[0].ToNumber();
                    S(m, G(m, "a") * k, G(m, "b") * k, G(m, "c") * k, G(m, "d") * k, G(m, "e") * k, G(m, "f") * k);
                }
                return Self(m);
            }, "m");
            Proc("/matrix", "Invert", (m, _) =>
            {
                double A = G(m, "a"), B = G(m, "b"), C = G(m, "c"), D = G(m, "d"), E = G(m, "e"), F = G(m, "f");
                var det = A * E - B * D;
                if (det != 0) S(m, E / det, -B / det, (B * F - C * E) / det, -D / det, A / det, (C * D - A * F) / det);
                return Self(m);
            });
        }

        private static void Var(string path, string name, DMValue value) => DMTypes.DefineVar(path, name, value);
        private static void Init(string path, string name, DMVarInitializer init) => DMTypes.DefineVarInit(path, name, init);
        private static void Proc(string path, string name, DMProcHandler h, params string[] args) => DMTypes.DefineProc(path, name, h, args);
    }

    /// <summary>The world datum: world.time and world.tick_lag are live views of the scheduler.</summary>
    public sealed class DMWorld : DMRuntime
    {
        public DMWorld() : base(DMTypes.GetOrThrow("/world"))
        {
            base.SetVar("maxx", DMValue.FromNumber(0));
            base.SetVar("maxy", DMValue.FromNumber(0));
            base.SetVar("maxz", DMValue.FromNumber(0));
            base.SetVar("view", DMValue.FromNumber(5));
            base.SetVar("system_type", DMValue.FromString("UNIX"));
            base.SetVar("byond_version", DMValue.FromNumber(516));
            base.SetVar("byond_build", DMValue.FromNumber(1655));
            base.SetVar("host", DMValue.Null);
            base.SetVar("cpu", DMValue.FromNumber(0));
            base.SetVar("map_cpu", DMValue.FromNumber(0));
            base.SetVar("tick_usage", DMValue.FromNumber(0));
            base.SetVar("name", DMValue.FromString("byond"));
            base.SetVar("log", DMValue.Null);
            base.SetVar("area", DMValue.FromPath("/area"));
            base.SetVar("turf", DMValue.FromPath("/turf"));
            base.SetVar("mob", DMValue.FromPath("/mob"));
            base.SetVar("contents", DMValue.FromList(new DMList()));
        }

        public override DMValue GetVar(string name) => name switch
        {
            "time" => DMValue.FromNumber(DMTickScheduler.Time),
            "tick_lag" => DMValue.FromNumber(DMTickScheduler.TickLag),
            "fps" => DMValue.FromNumber(10f / DMTickScheduler.TickLag),
            "realtime" => DMValue.FromNumber((DateTime.UtcNow - new DateTime(2000, 1, 1)).TotalMilliseconds / 100.0),
            "timeofday" => DMValue.FromNumber((DateTime.UtcNow - DateTime.UtcNow.Date).TotalMilliseconds / 100.0),
            "maxx" => base.GetVar("maxx"),
            _ => base.GetVar(name)
        };

        public override DMValue SetVar(string name, DMValue value)
        {
            switch (name)
            {
                case "tick_lag" when value.ToNumber() > 0:
                    DMTickScheduler.TickLag = (float)value.ToNumber();
                    return value;
                case "fps" when value.ToNumber() > 0:
                    DMTickScheduler.TickLag = 10f / (float)value.ToNumber();
                    return value;
                case "time":
                    return value;
            }
            return base.SetVar(name, value);
        }
    }

    /// <summary>Default atom procs with engine-free semantics (the engine adapter refines these).</summary>
    public static class DMAtomProcs
    {
        /// <summary>BYOND Move(): Exit/Enter checks, loc change, Exited/Entered notifications.</summary>
        public static async Task<DMValue> Move(DMRuntime src, DMValue[] args)
        {
            var newLoc = args.Length > 0 ? args[0] : DMValue.Null;
            var dir = args.Length > 1 ? args[1] : DMValue.Null;
            var target = newLoc.AsDatum();
            if (target == null) return DMValue.False;
            var oldLoc = src.GetVar("loc");
            var self = DMValue.FromDatum(src);
            if (oldLoc.AsDatum() is { } old && !(await old.CallProc("Exit", self, newLoc)).IsTrue()) return DMValue.False;
            if (!(await target.CallProc("Enter", self, oldLoc)).IsTrue()) return DMValue.False;
            if (dir.Type == DMValueType.Number && dir.ToNumber() != 0) src.SetVar("dir", dir);
            src.SetVar("loc", newLoc);
            if (oldLoc.AsDatum() is { } left) await left.CallProc("Exited", self, newLoc);
            await target.CallProc("Entered", self, oldLoc);
            return DMValue.True;
        }
    }
}
