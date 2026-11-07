// FullMeta Ray Tracing application - native 2D sequential ray tracer (stub solver).
//
// Protocol (FullMeta kernel "json-stdio"):
//   raytrace2d.exe --trace          request JSON on stdin  -> result JSON on stdout
//   raytrace2d.exe --trace <file>   reads a model / request JSON file instead (for testing)
// The request is either {"model": <raytrace model document>} or the model document itself.
// Errors go to stderr with a non-zero exit code.
//
// Build: applications/raytrace/solver/build.ps1 (uses the .NET Framework csc.exe shipped with Windows).

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace FullMeta.RayTrace
{
    struct Vec
    {
        public double X, Y;
        public Vec(double x, double y) { X = x; Y = y; }
        public static Vec operator +(Vec a, Vec b) { return new Vec(a.X + b.X, a.Y + b.Y); }
        public static Vec operator -(Vec a, Vec b) { return new Vec(a.X - b.X, a.Y - b.Y); }
        public static Vec operator *(double s, Vec a) { return new Vec(s * a.X, s * a.Y); }
        public double Dot(Vec b) { return X * b.X + Y * b.Y; }
        public double Length { get { return Math.Sqrt(X * X + Y * Y); } }
        public Vec Unit { get { double l = Length; return new Vec(X / l, Y / l); } }
    }

    class Surface
    {
        public string Id, Name;
        public double X, Radius, SemiAperture, NAfter;
    }

    class RayResult
    {
        public List<Vec> Points = new List<Vec>();
        public string Status = "missed";   // screen | blocked | tir | missed
        public string StoppedAt;           // surface id where blocked / TIR
        public double? ScreenY;
        public Vec FinalDir;
    }

    static class Program
    {
        const double Eps = 1e-9;

        static int Main(string[] args)
        {
            try
            {
                if (args.Length < 1 || args[0] != "--trace")
                {
                    Console.Error.WriteLine("usage: raytrace2d.exe --trace [request.json]   (reads stdin when no file is given)");
                    return 2;
                }
                string input = args.Length > 1 ? File.ReadAllText(args[1], Encoding.UTF8)
                                               : new StreamReader(Console.OpenStandardInput(), Encoding.UTF8).ReadToEnd();
                var json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
                var root = json.DeserializeObject(input.TrimStart('﻿')) as Dictionary<string, object>;
                if (root == null) throw new Exception("The request must be a JSON object.");
                var document = root.ContainsKey("model") && root["model"] is Dictionary<string, object>
                               && ((Dictionary<string, object>)root["model"]).ContainsKey("model")
                    ? (Dictionary<string, object>)root["model"] : root;
                var result = Trace(document);
                var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
                stdout.Write(json.Serialize(result));
                stdout.Flush();
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("raytrace2d: " + error.Message);
                return 1;
            }
        }

        // ---- model access helpers -------------------------------------------------------
        static Dictionary<string, object> Obj(Dictionary<string, object> parent, string key)
        {
            object value;
            if (!parent.TryGetValue(key, out value) || !(value is Dictionary<string, object>))
                throw new Exception("Model is missing object '" + key + "'.");
            return (Dictionary<string, object>)value;
        }
        static double Num(Dictionary<string, object> parent, string key, double fallback)
        {
            object value;
            if (!parent.TryGetValue(key, out value) || value == null) return fallback;
            return Convert.ToDouble(value, CultureInfo.InvariantCulture);
        }
        static string Str(Dictionary<string, object> parent, string key, string fallback)
        {
            object value;
            return parent.TryGetValue(key, out value) && value is string ? (string)value : fallback;
        }

        // ---- tracing -------------------------------------------------------------------
        static Dictionary<string, object> Trace(Dictionary<string, object> document)
        {
            var model = Obj(document, "model");
            var source = Obj(model, "source");
            var screen = Obj(model, "screen");
            var settings = model.ContainsKey("settings") ? Obj(model, "settings") : new Dictionary<string, object>();
            double ambient = Num(settings, "ambientIndex", 1.0);

            var surfaces = new List<Surface>();
            object rawSurfaces;
            if (model.TryGetValue("surfaces", out rawSurfaces) && rawSurfaces is IEnumerable)
            {
                foreach (var item in (IEnumerable)rawSurfaces)
                {
                    var s = item as Dictionary<string, object>;
                    if (s == null) continue;
                    surfaces.Add(new Surface
                    {
                        Id = Str(s, "id", "surface" + surfaces.Count),
                        Name = Str(s, "name", "Surface"),
                        X = Num(s, "x", 0), Radius = Num(s, "radius", 0),
                        SemiAperture = Num(s, "semiAperture", 10), NAfter = Num(s, "nAfter", 1)
                    });
                }
            }
            surfaces.Sort((a, b) => a.X.CompareTo(b.X));

            double screenX = Num(screen, "x", 100), screenHalf = Num(screen, "height", 40) / 2;
            var rays = new List<RayResult>();
            foreach (var start in SourceRays(source))
                rays.Add(TraceRay(start.Key, start.Value, surfaces, ambient, screenX, screenHalf));

            // Statistics on the screen and best focus (least-squares waist of the final ray bundle).
            var hits = new List<double>();
            var finals = new List<KeyValuePair<Vec, Vec>>();
            foreach (var r in rays)
            {
                if (r.ScreenY.HasValue) hits.Add(r.ScreenY.Value);
                if (r.Status == "screen" && Math.Abs(r.FinalDir.X) > Eps)
                    finals.Add(new KeyValuePair<Vec, Vec>(r.Points[r.Points.Count - 2], r.FinalDir));
            }
            var stats = new Dictionary<string, object>();
            stats["rayCount"] = rays.Count;
            stats["raysOnScreen"] = hits.Count;
            if (hits.Count > 0)
            {
                double mean = 0; foreach (var y in hits) mean += y; mean /= hits.Count;
                double variance = 0; foreach (var y in hits) variance += (y - mean) * (y - mean);
                stats["screenCentroidMm"] = mean;
                stats["screenRmsSpotMm"] = Math.Sqrt(variance / hits.Count);
            }
            if (finals.Count >= 2)
            {
                // y_i(x) = a_i + b_i x ; minimise sum (y_i - mean)^2 over x  ->  quadratic in x.
                double n = finals.Count, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
                foreach (var f in finals)
                {
                    double b = f.Value.Y / f.Value.X, a = f.Key.Y - b * f.Key.X;
                    sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
                }
                double varB = sbb / n - (sb / n) * (sb / n), covAB = sab / n - (sa / n) * (sb / n);
                if (varB > 1e-15)
                {
                    double xFocus = -covAB / varB;
                    double varA = saa / n - (sa / n) * (sa / n);
                    double rms = Math.Sqrt(Math.Max(0, varA + 2 * covAB * xFocus + varB * xFocus * xFocus));
                    stats["bestFocusXmm"] = xFocus;
                    stats["bestFocusRmsMm"] = rms;
                }
            }

            var rayList = new List<object>();
            foreach (var r in rays)
            {
                var points = new List<object>();
                foreach (var p in r.Points) points.Add(new[] { p.X, p.Y });
                var entry = new Dictionary<string, object> { { "status", r.Status }, { "points", points } };
                if (r.ScreenY.HasValue) entry["screenY"] = r.ScreenY.Value;
                if (r.StoppedAt != null) entry["stoppedAt"] = r.StoppedAt;
                rayList.Add(entry);
            }
            return new Dictionary<string, object>
            {
                { "schema", "raytrace-result/1" },
                { "solver", "raytrace2d.exe (C#, sequential 2D, vector Snell's law)" },
                { "rays", rayList },
                { "stats", stats }
            };
        }

        static IEnumerable<KeyValuePair<Vec, Vec>> SourceRays(Dictionary<string, object> source)
        {
            string kind = Str(source, "kind", "collimated");
            double sx = Num(source, "x", -20), sy = Num(source, "y", 0);
            double angle = Num(source, "angleDeg", 0) * Math.PI / 180;
            double width = Num(source, "width", 10);
            int count = Math.Max(1, Math.Min(500, (int)Num(source, "rayCount", 11)));
            for (int i = 0; i < count; i++)
            {
                double f = count == 1 ? 0 : (double)i / (count - 1) - 0.5;   // -0.5 .. 0.5
                if (kind == "point")
                {
                    double a = f * angle;
                    yield return new KeyValuePair<Vec, Vec>(new Vec(sx, sy), new Vec(Math.Cos(a), Math.Sin(a)));
                }
                else
                {
                    var dir = new Vec(Math.Cos(angle), Math.Sin(angle));
                    var perp = new Vec(-dir.Y, dir.X);
                    yield return new KeyValuePair<Vec, Vec>(new Vec(sx, sy) + (f * width) * perp, dir);
                }
            }
        }

        static RayResult TraceRay(Vec p, Vec d, List<Surface> surfaces, double ambient, double screenX, double screenHalf)
        {
            var ray = new RayResult();
            ray.Points.Add(p);
            double n1 = ambient;
            foreach (var s in surfaces)
            {
                Vec hit, normal;
                if (!Intersect(p, d, s, out hit, out normal) || Math.Abs(hit.Y) > s.SemiAperture)
                {
                    // Blocked by the aperture stop: end the ray on the surface's vertex plane.
                    if (Math.Abs(d.X) > Eps) ray.Points.Add(p + ((s.X - p.X) / d.X) * d);
                    ray.Status = "blocked"; ray.StoppedAt = s.Id; ray.FinalDir = d;
                    return ray;
                }
                ray.Points.Add(hit);
                double n2 = s.NAfter;
                if (normal.Dot(d) > 0) normal = -1 * normal;          // normal faces the incoming ray
                double eta = n1 / n2, cosI = -normal.Dot(d);
                double k = 1 - eta * eta * (1 - cosI * cosI);
                if (k < 0) { ray.Status = "tir"; ray.StoppedAt = s.Id; ray.FinalDir = d; return ray; }
                d = (eta * d + (eta * cosI - Math.Sqrt(k)) * normal).Unit;
                p = hit; n1 = n2;
            }
            ray.FinalDir = d;
            if (d.X > Eps && screenX > p.X)
            {
                var onScreen = p + ((screenX - p.X) / d.X) * d;
                ray.Points.Add(onScreen);
                if (Math.Abs(onScreen.Y) <= screenHalf) { ray.Status = "screen"; ray.ScreenY = onScreen.Y; }
                else ray.Status = "missed";
            }
            else
            {
                ray.Points.Add(p + 20 * d);
                ray.Status = "missed";
            }
            return ray;
        }

        static bool Intersect(Vec p, Vec d, Surface s, out Vec hit, out Vec normal)
        {
            hit = new Vec(); normal = new Vec(-1, 0);
            if (Math.Abs(s.Radius) < Eps)
            {
                if (Math.Abs(d.X) < Eps) return false;
                double t = (s.X - p.X) / d.X;
                if (t <= Eps) return false;
                hit = p + t * d; normal = new Vec(-1, 0);
                return true;
            }
            var c = new Vec(s.X + s.Radius, 0);
            var oc = p - c;
            double b = oc.Dot(d), cc = oc.Dot(oc) - s.Radius * s.Radius;
            double disc = b * b - cc;
            if (disc < 0) return false;
            double sq = Math.Sqrt(disc);
            double best = double.NaN, bestDistance = double.MaxValue;
            foreach (double t in new[] { -b - sq, -b + sq })
            {
                if (t <= Eps) continue;
                var h = p + t * d;
                double distance = Math.Abs(h.X - s.X);           // keep the cap nearest the vertex
                if (distance < bestDistance) { bestDistance = distance; best = t; }
            }
            if (double.IsNaN(best) || bestDistance > Math.Abs(s.Radius)) return false;
            hit = p + best * d;
            normal = (hit - c).Unit;
            return true;
        }
    }
}
