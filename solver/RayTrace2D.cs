// FullMeta Ray Tracing application - native 2D sequential ray tracer.
//
// Protocol (FullMeta kernel "json-stdio"):
//   raytrace2d.exe --trace          request JSON on stdin  -> result JSON on stdout
//   raytrace2d.exe --trace <file>   reads a model / request JSON file instead (for testing)
// The request is either {"model": <raytrace model document>} or the model document itself.
// Errors go to stderr with a non-zero exit code.
//
// Reads raytrace-model/2 (materials + wavelengths) and raytrace-model/1 (nAfter / ambientIndex) and writes
// raytrace-result/2. Mirrors js/trace2d.js + js/materials.js (same algorithm, same output); keep them in sync.
//
// Build: applications/raytracing/solver/build.ps1 (uses the .NET Framework csc.exe shipped with Windows).

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
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

    class Material
    {
        public string Id, Name, Formula;
        public double N, A;
        public double[] B = new double[0], C = new double[0];
        public double[] ValidRangeUm;   // null when not declared
    }

    class Surface
    {
        public string Id, Name;
        public int Index;
        public double X, Radius, SemiAperture;
        public Material Material;
    }

    class Wavelength
    {
        public string Id, Label, Color;
        public double LambdaNm, Weight;
    }

    class RayResult
    {
        public List<Vec> Points = new List<Vec>();
        public string Status = "missed";   // screen | blocked | tir | missed
        public string StoppedAt;           // surface id where blocked / TIR
        public double? ScreenY;
        public Vec LastP, FinalDir;
    }

    static class Materials
    {
        public const double LineF = 486.1327, LineD = 587.5618, LineC = 656.2725;

        static string Label(Material m) { return !string.IsNullOrEmpty(m.Name) ? m.Name : !string.IsNullOrEmpty(m.Id) ? m.Id : "material"; }

        // Same formulas as js/materials.js (λ in µm).
        public static double Index(Material m, double lambdaNm)
        {
            double um = lambdaNm / 1000, l2 = um * um, n;
            switch (m.Formula ?? "constant")
            {
                case "constant": n = m.N; break;
                case "cauchy":
                    n = m.A;
                    for (int i = 0; i < m.B.Length; i++) n += m.B[i] / Math.Pow(l2, i + 1);
                    break;
                case "sellmeier":
                {
                    if (m.B.Length != m.C.Length) throw new Exception("Material " + Label(m) + ": Sellmeier B and C need the same number of terms.");
                    double n2 = 1;
                    for (int i = 0; i < m.B.Length; i++) n2 += m.B[i] * l2 / (l2 - m.C[i]);
                    n = n2 > 0 ? Math.Sqrt(n2) : double.NaN;
                    break;
                }
                case "gas":
                    if (m.B.Length != m.C.Length) throw new Exception("Material " + Label(m) + ": gas formula B and C need the same number of terms.");
                    n = 1;
                    for (int i = 0; i < m.B.Length; i++) n += m.B[i] / (m.C[i] - 1 / l2);
                    break;
                default: throw new Exception("Material " + Label(m) + ": unknown formula \"" + m.Formula + "\".");
            }
            if (double.IsNaN(n) || double.IsInfinity(n) || n <= 0)
                throw new Exception("Material " + Label(m) + " has no valid refractive index at " + Program.Fmt(lambdaNm) + " nm.");
            return n;
        }

        public static Dictionary<string, object> Abbe(Material m)
        {
            double nF = Index(m, LineF), nd = Index(m, LineD), nC = Index(m, LineC), dn = nF - nC;
            return new Dictionary<string, object> {
                { "id", m.Id }, { "nF", nF }, { "nd", nd }, { "nC", nC },
                { "abbeVd", Math.Abs(dn) > 1e-12 ? (object)((nd - 1) / dn) : null } };
        }

        public static bool OutsideValidRange(Material m, double lambdaNm)
        {
            if (m.ValidRangeUm == null || m.ValidRangeUm.Length != 2) return false;
            double um = lambdaNm / 1000;
            return um < m.ValidRangeUm[0] || um > m.ValidRangeUm[1];
        }

        // Bruton's piecewise fit, identical to wavelengthColor() in js/materials.js.
        public static string Color(double l)
        {
            double r = 0, g = 0, b = 0;
            if (l >= 380 && l < 440) { r = -(l - 440) / 60; b = 1; }
            else if (l >= 440 && l < 490) { g = (l - 440) / 50; b = 1; }
            else if (l >= 490 && l < 510) { g = 1; b = -(l - 510) / 20; }
            else if (l >= 510 && l < 580) { r = (l - 510) / 70; g = 1; }
            else if (l >= 580 && l < 645) { r = 1; g = -(l - 645) / 65; }
            else if (l >= 645 && l <= 780) { r = 1; }
            else return "#9aa4ae";
            double fade = l < 420 ? 0.3 + 0.7 * (l - 380) / 40 : l > 700 ? 0.3 + 0.7 * (780 - l) / 80 : 1;
            Func<double, string> channel = c => ((int)Math.Floor(255 * Math.Pow(Math.Max(0, c) * fade, 0.8) + 0.5)).ToString("x2");
            return "#" + channel(r) + channel(g) + channel(b);
        }
    }

    // Source spectra, identical to js/spectra.js (planckRelative, spectrumDensity, binSpectrum).
    static class Spectra
    {
        const double PlanckC2NmK = 1.438776877e7;

        public static double Planck(double lambdaNm, double temperatureK)
        {
            double x = PlanckC2NmK / (lambdaNm * temperatureK);
            double expm1 = Math.Abs(x) < 1e-5 ? x + 0.5 * x * x : Math.Exp(x) - 1;   // JS Math.expm1
            return 1 / (Math.Pow(lambdaNm, 5) * expm1);
        }

        // Returns null for no spectrum / kind "wavelengths"; else (band centre nm, normalised band power) pairs.
        public static List<KeyValuePair<double, double>> Bin(Dictionary<string, object> spec, string label)
        {
            object kindValue;
            string kind = spec.TryGetValue("kind", out kindValue) && kindValue is string ? (string)kindValue : "";
            if (kind == "" || kind == "wavelengths") return null;
            Func<double, double> density;
            double minNm, maxNm;
            if (kind == "blackbody")
            {
                double T = Program.NumOf(spec, "temperatureK", 5778);
                minNm = Program.NumOf(spec, "minNm", 300); maxNm = Program.NumOf(spec, "maxNm", 2500);
                if (!(T > 0)) throw new Exception(label + ": blackbody temperature must be positive.");
                density = l => Planck(l, T);
            }
            else if (kind == "table")
            {
                var points = new List<double[]>();
                object raw;
                if (spec.TryGetValue("points", out raw) && raw is IEnumerable && !(raw is string))
                    foreach (var item in (IEnumerable)raw)
                    {
                        var pair = item as IEnumerable;
                        if (pair == null || item is string) continue;
                        var values = new List<double>();
                        foreach (var v in pair) values.Add(v == null ? double.NaN : Convert.ToDouble(v, CultureInfo.InvariantCulture));
                        if (values.Count < 2 || double.IsNaN(values[0]) || double.IsInfinity(values[0]) || double.IsNaN(values[1]) || double.IsInfinity(values[1])) continue;
                        points.Add(new[] { values[0], Math.Max(0, values[1]) });
                    }
                points = points.OrderBy(p => p[0]).ToList();
                if (points.Count < 2) throw new Exception(label + ": a tabulated spectrum needs at least two [nm, value] points.");
                minNm = Math.Max(points[0][0], Program.NumOf(spec, "minNm", points[0][0]));
                maxNm = Math.Min(points[points.Count - 1][0], Program.NumOf(spec, "maxNm", points[points.Count - 1][0]));
                density = l =>
                {
                    int lo = 0, hi = points.Count - 1;
                    while (hi - lo > 1) { int mid = (lo + hi) >> 1; if (points[mid][0] <= l) lo = mid; else hi = mid; }
                    double x0 = points[lo][0], y0 = points[lo][1], x1 = points[hi][0], y1 = points[hi][1];
                    return x1 == x0 ? y0 : y0 + (y1 - y0) * (Math.Min(Math.Max(l, x0), x1) - x0) / (x1 - x0);
                };
            }
            else throw new Exception(label + ": unknown spectrum kind \"" + kind + "\".");
            if (!(minNm > 0 && maxNm > minNm)) throw new Exception(label + ": spectrum range must satisfy 0 < min < max.");
            int n = Math.Max(1, Math.Min(200, (int)Math.Truncate(Program.NumOf(spec, "bins", 16))));
            double width = (maxNm - minNm) / n, total = 0;
            var bins = new List<KeyValuePair<double, double>>();
            for (int i = 0; i < n; i++)
            {
                double a = minNm + i * width, w = Simpson(density, a, a + width, 64);
                bins.Add(new KeyValuePair<double, double>(a + width / 2, w));
                total += w;
            }
            if (!(total > 0)) throw new Exception(label + ": the spectrum has no power in " + Program.Fmt(minNm) + "–" + Program.Fmt(maxNm) + " nm.");
            return bins.Select(b => new KeyValuePair<double, double>(b.Key, b.Value / total)).ToList();
        }

        static double Simpson(Func<double, double> f, double a, double b, int n)
        {
            double h = (b - a) / n, s = f(a) + f(b);
            for (int i = 1; i < n; i++) s += (i % 2 == 1 ? 4 : 2) * f(a + i * h);
            return s * h / 3;
        }
    }

    static class Program
    {
        const double Eps = 1e-9;
        const double ParaxialHeightMm = 0.01, ParaxialAngleRad = 1e-4;

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
        public static string Fmt(double value) { return value.ToString("R", CultureInfo.InvariantCulture); }
        public static double NumOf(Dictionary<string, object> parent, string key, double fallback) { return Num(parent, key, fallback); }

        static Dictionary<string, object> Obj(Dictionary<string, object> parent, string key)
        {
            object value;
            if (!parent.TryGetValue(key, out value) || !(value is Dictionary<string, object>))
                throw new Exception("Model is missing object '" + key + "'.");
            return (Dictionary<string, object>)value;
        }
        static Dictionary<string, object> OptObj(Dictionary<string, object> parent, string key)
        {
            object value;
            return parent.TryGetValue(key, out value) && value is Dictionary<string, object> ? (Dictionary<string, object>)value
                : new Dictionary<string, object>();
        }
        static bool IsNumber(object value)
        {
            return value is int || value is long || value is double || value is decimal || value is float;
        }
        static bool Has(Dictionary<string, object> parent, string key)
        {
            object value;
            return parent.TryGetValue(key, out value) && value != null && !(value is string && (string)value == "");
        }
        static double Num(Dictionary<string, object> parent, string key, double fallback)
        {
            object value;
            if (!parent.TryGetValue(key, out value) || value == null) return fallback;
            if (IsNumber(value)) return Convert.ToDouble(value, CultureInfo.InvariantCulture);
            double parsed;
            return value is string && double.TryParse((string)value, NumberStyles.Float, CultureInfo.InvariantCulture, out parsed) ? parsed : fallback;
        }
        static string Str(Dictionary<string, object> parent, string key)
        {
            object value;
            return parent.TryGetValue(key, out value) && value is string ? (string)value : "";
        }
        static double[] Numbers(Dictionary<string, object> parent, string key)
        {
            object value;
            if (!parent.TryGetValue(key, out value) || !(value is IEnumerable) || value is string) return new double[0];
            var list = new List<double>();
            foreach (var item in (IEnumerable)value) list.Add(item == null ? double.NaN : Convert.ToDouble(item, CultureInfo.InvariantCulture));
            return list.ToArray();
        }
        static IEnumerable<Dictionary<string, object>> Items(Dictionary<string, object> parent, string key)
        {
            object value;
            if (!parent.TryGetValue(key, out value) || !(value is IEnumerable) || value is string) yield break;
            foreach (var item in (IEnumerable)value) if (item is Dictionary<string, object>) yield return (Dictionary<string, object>)item;
        }

        // ---- model resolution (both formats) -------------------------------------------
        class Resolved
        {
            public List<Material> Materials = new List<Material>();
            public Material Ambient;
            public List<Surface> Surfaces = new List<Surface>();
            public List<Wavelength> Wavelengths = new List<Wavelength>();
            public string PrimaryId;
            public List<string> Warnings = new List<string>();
        }

        static Resolved Resolve(Dictionary<string, object> model)
        {
            var r = new Resolved();
            var byId = new Dictionary<string, Material>();
            Func<Material, Material> add = m => { if (!byId.ContainsKey(m.Id)) { byId[m.Id] = m; r.Materials.Add(m); } return byId[m.Id]; };
            Func<double, Material> constant = n => new Material { Id = "n=" + Fmt(n), Name = "n = " + Fmt(n), Formula = "constant", N = n };
            Func<string, string, Material> lookup = (id, owner) =>
            {
                Material m;
                if (!byId.TryGetValue(id, out m)) throw new Exception(owner + " refers to unknown material \"" + id + "\".");
                return m;
            };

            foreach (var m in Items(model, "materials"))
            {
                string id = Str(m, "id");
                if (id == "") continue;
                var range = Numbers(m, "validRangeUm");
                add(new Material
                {
                    Id = id, Name = Str(m, "name"), Formula = Str(m, "formula") == "" ? "constant" : Str(m, "formula"),
                    N = Num(m, "n", double.NaN), A = Num(m, "A", double.NaN), B = Numbers(m, "B"), C = Numbers(m, "C"),
                    ValidRangeUm = range.Length == 2 ? range : null
                });
            }

            var settings = OptObj(model, "settings");
            r.Ambient = Str(settings, "ambientMaterial") != "" ? lookup(Str(settings, "ambientMaterial"), "Ambient medium")
                : add(constant(Num(settings, "ambientIndex", 1)));

            int index = 0;
            foreach (var s in Items(model, "surfaces"))
            {
                string id = Str(s, "id") == "" ? "surface" + index : Str(s, "id");
                string name = Str(s, "name") == "" ? "Surface" : Str(s, "name");
                Material material = Str(s, "materialAfter") != "" ? lookup(Str(s, "materialAfter"), "Surface " + (Str(s, "name") == "" ? id : Str(s, "name")))
                    : Has(s, "nAfter") ? add(constant(Num(s, "nAfter", 1))) : r.Ambient;
                r.Surfaces.Add(new Surface
                {
                    Id = id, Name = name, Index = index, X = Num(s, "x", 0), Radius = Num(s, "radius", 0),
                    SemiAperture = Math.Max(Eps, Num(s, "semiAperture", 10)), Material = material
                });
                index++;
            }
            // Stable sort by x (List.Sort is unstable; JS Array.prototype.sort is stable).
            r.Surfaces = r.Surfaces.OrderBy(s => s.X).ToList();

            var colorPattern = new Regex("^#[0-9a-fA-F]{6}$");
            int k = 0;
            // A source spectrum (blackbody / table) replaces the wavelength list with weighted bins (js/spectra.js binSpectrum).
            var bins = Spectra.Bin(OptObj(OptObj(model, "source"), "spectrum"), "Light source");
            if (bins != null)
            {
                for (int i = 0; i < bins.Count; i++)
                    r.Wavelengths.Add(new Wavelength
                    {
                        Id = "bin" + (i + 1), Label = "bin " + (i + 1),
                        LambdaNm = bins[i].Key, Weight = Math.Max(0, bins[i].Value), Color = Materials.Color(bins[i].Key)
                    });
            }
            foreach (var w in bins != null ? Enumerable.Empty<Dictionary<string, object>>() : Items(model, "wavelengths"))
            {
                double lambda = Num(w, "lambdaNm", double.NaN);
                if (double.IsNaN(lambda) || double.IsInfinity(lambda)) continue;
                r.Wavelengths.Add(new Wavelength
                {
                    Id = Str(w, "id") == "" ? "w" + k : Str(w, "id"),
                    Label = Str(w, "label") == "" ? Fmt(lambda) + " nm" : Str(w, "label"),
                    LambdaNm = lambda, Weight = Math.Max(0, Num(w, "weight", 1)),
                    Color = colorPattern.IsMatch(Str(w, "color")) ? Str(w, "color") : Materials.Color(lambda)
                });
                k++;
            }
            if (r.Wavelengths.Count == 0)
                r.Wavelengths.Add(new Wavelength { Id = "d", Label = "d", LambdaNm = Materials.LineD, Weight = 1, Color = Materials.Color(Materials.LineD) });

            string primary = Str(settings, "primaryWavelength");
            var found = r.Wavelengths.FirstOrDefault(w => w.Id == primary);
            if (found == null && bins != null)
            {
                found = r.Wavelengths[0];                                    // strongest band (first of equal maxima)
                foreach (var w in r.Wavelengths) if (w.Weight > found.Weight) found = w;
            }
            if (found == null)
            {
                if (primary != "") r.Warnings.Add("Primary wavelength \"" + primary + "\" not found; using " + r.Wavelengths[0].Label + ".");
                found = r.Wavelengths[0];
            }
            r.PrimaryId = found.Id;
            return r;
        }

        // ---- tracing -------------------------------------------------------------------
        class Source { public string Kind; public double Sx, Sy, Angle, Width; public int Count; }

        static Source SourceGeometry(Dictionary<string, object> source)
        {
            return new Source
            {
                Kind = Str(source, "kind") == "point" ? "point" : "collimated",
                Sx = Num(source, "x", -20), Sy = Num(source, "y", 0),
                Angle = Num(source, "angleDeg", 0) * Math.PI / 180,
                Width = Num(source, "width", 10),
                Count = Math.Max(1, Math.Min(500, (int)Math.Truncate(Num(source, "rayCount", 11))))
            };
        }

        static List<KeyValuePair<Vec, Vec>> SourceRays(Source g)
        {
            var rays = new List<KeyValuePair<Vec, Vec>>();
            for (int i = 0; i < g.Count; i++)
            {
                double f = g.Count == 1 ? 0 : (double)i / (g.Count - 1) - 0.5;   // -0.5 .. 0.5
                if (g.Kind == "point")
                {
                    double a = f * g.Angle;
                    rays.Add(new KeyValuePair<Vec, Vec>(new Vec(g.Sx, g.Sy), new Vec(Math.Cos(a), Math.Sin(a))));
                }
                else
                {
                    var d = new Vec(Math.Cos(g.Angle), Math.Sin(g.Angle));
                    rays.Add(new KeyValuePair<Vec, Vec>(new Vec(g.Sx - f * g.Width * d.Y, g.Sy + f * g.Width * d.X), d));
                }
            }
            return rays;
        }

        // Central ray plus a near-axis neighbour, used for the paraxial focus.
        static KeyValuePair<Vec, Vec>[] ParaxialPair(Source g)
        {
            if (g.Kind == "point")
                return new[] {
                    new KeyValuePair<Vec, Vec>(new Vec(g.Sx, g.Sy), new Vec(1, 0)),
                    new KeyValuePair<Vec, Vec>(new Vec(g.Sx, g.Sy), new Vec(Math.Cos(ParaxialAngleRad), Math.Sin(ParaxialAngleRad))) };
            var d = new Vec(Math.Cos(g.Angle), Math.Sin(g.Angle));
            return new[] {
                new KeyValuePair<Vec, Vec>(new Vec(g.Sx, g.Sy), d),
                new KeyValuePair<Vec, Vec>(new Vec(g.Sx - ParaxialHeightMm * d.Y, g.Sy + ParaxialHeightMm * d.X), d) };
        }

        static bool Intersect(Vec p, Vec d, Surface s, out Vec hit, out Vec normal)
        {
            hit = new Vec(); normal = new Vec(-1, 0);
            if (Math.Abs(s.Radius) < Eps)
            {
                if (Math.Abs(d.X) < Eps) return false;
                double t = (s.X - p.X) / d.X;
                if (t <= Eps) return false;
                hit = new Vec(p.X + t * d.X, p.Y + t * d.Y); normal = new Vec(-1, 0);
                return true;
            }
            var c = new Vec(s.X + s.Radius, 0);
            var oc = new Vec(p.X - c.X, p.Y - c.Y);
            double b = oc.X * d.X + oc.Y * d.Y, cc = oc.X * oc.X + oc.Y * oc.Y - s.Radius * s.Radius;
            double disc = b * b - cc;
            if (disc < 0) return false;
            double sq = Math.Sqrt(disc);
            double best = double.NaN, bestDistance = double.PositiveInfinity;
            foreach (double t in new[] { -b - sq, -b + sq })
            {
                if (t <= Eps) continue;
                double distance = Math.Abs(p.X + t * d.X - s.X);           // keep the cap nearest the vertex
                if (distance < bestDistance) { bestDistance = distance; best = t; }
            }
            if (double.IsNaN(best) || bestDistance > Math.Abs(s.Radius)) return false;
            hit = new Vec(p.X + best * d.X, p.Y + best * d.Y);
            var n = new Vec(hit.X - c.X, hit.Y - c.Y);
            double len = Math.Sqrt(n.X * n.X + n.Y * n.Y);
            normal = new Vec(n.X / len, n.Y / len);
            return true;
        }

        // indices[i] = refractive index after surfaces[i]; screenX = null skips the screen.
        static RayResult TraceRay(Vec p, Vec d, List<Surface> surfaces, double nAmbient, double[] indices, double? screenX, double screenHalf)
        {
            var ray = new RayResult();
            ray.Points.Add(p);
            double n1 = nAmbient;
            for (int i = 0; i < surfaces.Count; i++)
            {
                var s = surfaces[i];
                Vec hit, normal;
                if (!Intersect(p, d, s, out hit, out normal) || Math.Abs(hit.Y) > s.SemiAperture)
                {
                    if (Math.Abs(d.X) > Eps) { double t = (s.X - p.X) / d.X; ray.Points.Add(new Vec(p.X + t * d.X, p.Y + t * d.Y)); }
                    ray.Status = "blocked"; ray.StoppedAt = s.Id; ray.LastP = p; ray.FinalDir = d;
                    return ray;
                }
                ray.Points.Add(hit);
                if (normal.X * d.X + normal.Y * d.Y > 0) normal = new Vec(-normal.X, -normal.Y);
                double n2 = indices[i];
                double eta = n1 / n2, cosI = -(normal.X * d.X + normal.Y * d.Y);
                double k = 1 - eta * eta * (1 - cosI * cosI);
                if (k < 0) { ray.Status = "tir"; ray.StoppedAt = s.Id; ray.LastP = hit; ray.FinalDir = d; return ray; }
                double f = eta * cosI - Math.Sqrt(k);
                var nd = new Vec(eta * d.X + f * normal.X, eta * d.Y + f * normal.Y);
                double len = Math.Sqrt(nd.X * nd.X + nd.Y * nd.Y);
                d = new Vec(nd.X / len, nd.Y / len); p = hit; n1 = n2;
            }
            ray.LastP = p; ray.FinalDir = d;
            if (!screenX.HasValue) return ray;
            if (d.X > Eps && screenX.Value > p.X)
            {
                double t = (screenX.Value - p.X) / d.X;
                var onScreen = new Vec(p.X + t * d.X, p.Y + t * d.Y);
                ray.Points.Add(onScreen);
                if (Math.Abs(onScreen.Y) <= screenHalf) { ray.Status = "screen"; ray.ScreenY = onScreen.Y; }
            }
            else
            {
                ray.Points.Add(new Vec(p.X + 20 * d.X, p.Y + 20 * d.Y));
            }
            return ray;
        }

        static bool Usable(RayResult r) { return r.Status != "blocked" && r.Status != "tir" && Math.Abs(r.FinalDir.X) > Eps; }

        // Final ray line y = a + b x, from the last surface hit; returned as {a, b, w}.
        static double[] FinalLine(RayResult r, double w)
        {
            double b = r.FinalDir.Y / r.FinalDir.X;
            return new[] { r.LastP.Y - b * r.LastP.X, b, w };
        }

        // Weighted least-squares waist: minimises Σ w (y_i(x) − ȳ(x))². Returns {x, rms} or null.
        static double[] BestFocus(List<double[]> lines)
        {
            if (lines.Count < 2) return null;
            double sw = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
            foreach (var l in lines)
            {
                double a = l[0], b = l[1], w = l[2];
                sw += w; sa += w * a; sb += w * b; saa += w * a * a; sbb += w * b * b; sab += w * a * b;
            }
            if (sw <= 0) return null;
            double varB = sbb / sw - (sb / sw) * (sb / sw), covAB = sab / sw - (sa / sw) * (sb / sw), varA = saa / sw - (sa / sw) * (sa / sw);
            if (varB <= 1e-15) return null;
            double x = -covAB / varB;
            return new[] { x, Math.Sqrt(Math.Max(0, varA + 2 * covAB * x + varB * x * x)) };
        }

        // Weighted centroid and RMS of screen hits {y, w}. Returns {mean, rms} or null.
        static double[] Spot(List<double[]> hits)
        {
            double sw = 0, sy = 0;
            foreach (var h in hits) { sw += h[1]; sy += h[1] * h[0]; }
            if (hits.Count == 0 || sw <= 0) return null;
            double mean = sy / sw, v = 0;
            foreach (var h in hits) v += h[1] * (h[0] - mean) * (h[0] - mean);
            return new[] { mean, Math.Sqrt(v / sw) };
        }

        static double? ParaxialFocus(KeyValuePair<Vec, Vec>[] pair, List<Surface> surfaces, double nAmbient, double[] indices)
        {
            var chief = TraceRay(pair[0].Key, pair[0].Value, surfaces, nAmbient, indices, null, 0);
            var near = TraceRay(pair[1].Key, pair[1].Value, surfaces, nAmbient, indices, null, 0);
            if (!Usable(chief) || !Usable(near)) return null;
            var l1 = FinalLine(chief, 1); var l2 = FinalLine(near, 1);
            return Math.Abs(l2[1] - l1[1]) > 1e-15 ? (double?)((l1[0] - l2[0]) / (l2[1] - l1[1])) : null;
        }

        static Dictionary<string, object> BundleStats(List<RayResult> rays)
        {
            var hits = new List<double[]>();
            var lines = new List<double[]>();
            foreach (var r in rays)
            {
                if (r.ScreenY.HasValue) hits.Add(new[] { r.ScreenY.Value, 1.0 });
                if (r.Status == "screen" && Usable(r)) lines.Add(FinalLine(r, 1));
            }
            var stats = new Dictionary<string, object> { { "rayCount", rays.Count }, { "raysOnScreen", hits.Count } };
            var s = Spot(hits);
            if (s != null) { stats["screenCentroidMm"] = s[0]; stats["screenRmsSpotMm"] = s[1]; }
            var focus = BestFocus(lines);
            if (focus != null) { stats["bestFocusXmm"] = focus[0]; stats["bestFocusRmsMm"] = focus[1]; }
            return stats;
        }

        static Dictionary<string, object> Trace(Dictionary<string, object> document)
        {
            var model = Obj(document, "model");
            var resolved = Resolve(model);
            var surfaces = resolved.Surfaces;
            var screen = OptObj(model, "screen");
            double screenX = Num(screen, "x", 100), screenHalf = Num(screen, "height", 40) / 2;
            var geometry = SourceGeometry(OptObj(model, "source"));
            var starts = SourceRays(geometry);
            var pair = ParaxialPair(geometry);
            var warnings = new List<object>(resolved.Warnings);

            Func<double, double[]> indicesAt = lambda => surfaces.Select(s => Materials.Index(s.Material, lambda)).ToArray();
            var used = new List<Material> { resolved.Ambient };
            foreach (var s in surfaces) if (!used.Contains(s.Material)) used.Add(s.Material);
            foreach (var w in resolved.Wavelengths)
                foreach (var m in used)
                    if (Materials.OutsideValidRange(m, w.LambdaNm))
                        warnings.Add("λ = " + Fmt(w.LambdaNm) + " nm is outside the valid range of " + (string.IsNullOrEmpty(m.Name) ? m.Id : m.Name) + ".");

            var rayList = new List<object>();
            var perWavelength = new List<object>();
            var allHits = new List<double[]>();
            var allLines = new List<double[]>();
            var foci = new List<double>();
            foreach (var w in resolved.Wavelengths)
            {
                double nAmbient = Materials.Index(resolved.Ambient, w.LambdaNm);
                var indices = indicesAt(w.LambdaNm);
                var traced = starts.Select(st => TraceRay(st.Key, st.Value, surfaces, nAmbient, indices, screenX, screenHalf)).ToList();
                foreach (var r in traced)
                {
                    if (r.ScreenY.HasValue) allHits.Add(new[] { r.ScreenY.Value, w.Weight });
                    if (r.Status == "screen" && Usable(r)) allLines.Add(FinalLine(r, w.Weight));
                    var points = new List<object>();
                    foreach (var p in r.Points) points.Add(new[] { p.X, p.Y });
                    var entry = new Dictionary<string, object> { { "wavelength", w.Id }, { "status", r.Status }, { "points", points } };
                    if (r.StoppedAt != null) entry["stoppedAt"] = r.StoppedAt;
                    if (r.ScreenY.HasValue) entry["screenY"] = r.ScreenY.Value;
                    rayList.Add(entry);
                }
                var stats = BundleStats(traced);
                var paraxial = ParaxialFocus(pair, surfaces, nAmbient, indices);
                if (paraxial.HasValue) { stats["paraxialFocusXmm"] = paraxial.Value; foci.Add(paraxial.Value); }
                var indexMap = new Dictionary<string, object>();
                for (int i = 0; i < surfaces.Count; i++) indexMap[surfaces[i].Id] = indices[i];
                perWavelength.Add(new Dictionary<string, object> {
                    { "id", w.Id }, { "label", w.Label }, { "lambdaNm", w.LambdaNm }, { "weight", w.Weight }, { "color", w.Color },
                    { "indices", indexMap }, { "stats", stats } });
            }

            var summary = new Dictionary<string, object>();
            var poly = Spot(allHits);
            if (poly != null) { summary["polychromaticCentroidMm"] = poly[0]; summary["polychromaticRmsSpotMm"] = poly[1]; }
            var polyFocus = BestFocus(allLines);
            if (polyFocus != null) { summary["polychromaticBestFocusXmm"] = polyFocus[0]; summary["polychromaticBestFocusRmsMm"] = polyFocus[1]; }

            // Chromatic focal shift, always between the F and C lines (independent of the model's wavelength list).
            Func<double, KeyValuePair<double?, double?>> atLine = lambda =>
            {
                double nAmbient = Materials.Index(resolved.Ambient, lambda);
                var indices = indicesAt(lambda);
                var bundle = BundleStats(starts.Select(st => TraceRay(st.Key, st.Value, surfaces, nAmbient, indices, screenX, screenHalf)).ToList());
                return new KeyValuePair<double?, double?>(ParaxialFocus(pair, surfaces, nAmbient, indices),
                    bundle.ContainsKey("bestFocusXmm") ? (double?)(double)bundle["bestFocusXmm"] : null);
            };
            var F = atLine(Materials.LineF); var C = atLine(Materials.LineC);
            var shift = new Dictionary<string, object>();
            if (F.Key.HasValue && C.Key.HasValue) shift["paraxialFC"] = F.Key.Value - C.Key.Value;
            if (F.Value.HasValue && C.Value.HasValue) shift["bestFocusFC"] = F.Value.Value - C.Value.Value;
            if (foci.Count > 0) shift["rangeAll"] = foci.Max() - foci.Min();
            summary["chromaticFocalShiftMm"] = shift;

            return new Dictionary<string, object>
            {
                { "schema", "raytrace-result/2" },
                { "solver", "raytrace2d.exe (C#, sequential 2D, vector Snell's law)" },
                { "primaryWavelength", resolved.PrimaryId },
                { "rays", rayList },
                { "wavelengths", perWavelength },
                { "materials", resolved.Materials.Select(m => (object)Materials.Abbe(m)).ToList() },
                { "stats", summary },
                { "warnings", warnings }
            };
        }
    }
}
