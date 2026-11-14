// 民间卫戍协议 · UI 布局编辑器 · 内置浏览器宿主
//
// 一个很小的 WebView2 窗口：先显示「选择游戏目录」页（host/web/picker.html），
// 选好以后隐藏控制台启动 app.mjs --embedded，等它把服务端 / 编辑代理起好，
// 再跳转到 /ui-editor/studio.html —— 左侧游戏画面 + 右侧侧边栏。
//
// 只用 .NET Framework 4.8 自带的东西 + 游戏目录里的 WebView2 SDK / 运行时，不额外装依赖。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: System.Reflection.AssemblyVersion("1.2.1.0")]

namespace StrongholdUIEditor
{
    internal static class Program
    {
        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try { SetProcessDPIAware(); } catch { /* 忽略 */ }

            var options = HostOptions.Parse(args);
            bool createdNew;
            using (var mutex = new Mutex(true, @"Local\StrongholdUIEditor.SingleInstance", out createdNew))
            {
                if (!createdNew)
                {
                    MessageBox.Show("UI 布局编辑器已经在运行。", "民间卫戍协议 · UI 布局编辑器",
                        MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                Application.Run(new HostForm(options));
            }
        }
    }

    internal sealed class HostOptions
    {
        public string GameDir;
        public string WebView2Folder;
        public int DebugPort;
        public bool DevTools;

        public static HostOptions Parse(string[] args)
        {
            var options = new HostOptions();
            for (var i = 0; i < args.Length; i++)
            {
                var arg = args[i] ?? string.Empty;
                switch (arg.ToLowerInvariant())
                {
                    case "--game":
                        if (i + 1 < args.Length) options.GameDir = args[++i];
                        break;
                    case "--webview2":
                        if (i + 1 < args.Length) options.WebView2Folder = args[++i];
                        break;
                    case "--debug-port":
                        if (i + 1 < args.Length) int.TryParse(args[++i], out options.DebugPort);
                        break;
                    case "--devtools":
                        options.DevTools = true;
                        break;
                    default:
                        // 把游戏文件夹直接拖到 exe 上
                        if (!arg.StartsWith("--") && options.GameDir == null && Directory.Exists(arg)) options.GameDir = arg;
                        break;
                }
            }
            if (!string.IsNullOrWhiteSpace(options.GameDir)) options.GameDir = Path.GetFullPath(options.GameDir);
            if (!string.IsNullOrWhiteSpace(options.WebView2Folder)) options.WebView2Folder = Path.GetFullPath(options.WebView2Folder);
            return options;
        }
    }

    internal sealed class HostForm : Form
    {
        private const string VirtualHost = "stronghold.editor";
        private const string PickerUrl = "https://stronghold.editor/picker.html";

        private readonly HostOptions _options;
        private readonly string _toolDir;
        private readonly string _webRoot;
        private readonly Settings _settings;
        private readonly LogFile _log;
        private readonly WebView2 _web;
        private readonly Label _splash;
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

        private Process _node;
        private readonly object _nodeLock = new object();
        private bool _nodeStarting;
        private bool _pendingStopNode;
        private bool _confirmedClose;
        private bool _shuttingDown;
        private string _pendingStudioUrl;
        private string _lastPage = "picker";
        private int _nodeExitedCode = -1;

        public HostForm(HostOptions options)
        {
            _options = options;
            _toolDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            _webRoot = Path.Combine(_toolDir, "host", "web");
            _settings = Settings.Load();
            _log = new LogFile(Path.Combine(Settings.DataDir, "host.log"));

            Text = "民间卫戍协议 · UI 布局编辑器";
            BackColor = Color.FromArgb(7, 11, 9);
            ForeColor = Color.FromArgb(232, 242, 234);
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(1100, 680);
            Size = new Size(1480, 920);
            DoubleBuffered = true;
            try { Icon = new Icon(Path.Combine(_webRoot, "app.ico")); } catch { /* 没图标也能跑 */ }

            ApplySavedBounds();

            _splash = new Label
            {
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleCenter,
                Text = "正在启动内置浏览器…",
                ForeColor = Color.FromArgb(123, 240, 176),
                BackColor = Color.FromArgb(7, 11, 9),
                Font = new Font("Microsoft YaHei", 11f),
            };
            Controls.Add(_splash);

            _web = new WebView2
            {
                Dock = DockStyle.Fill,
                Visible = false,
                DefaultBackgroundColor = Color.FromArgb(7, 11, 9),
            };
            Controls.Add(_web);

            Load += async (sender, args) => await InitializeWebViewAsync();
            FormClosing += OnFormClosing;
            Shown += (sender, args) => { if (_settings.Maximized) WindowState = FormWindowState.Maximized; };
            _log.Info("host start; tool=" + _toolDir);
        }

        // ─────────────────────────────────────────────────────────── WebView2
        private async Task InitializeWebViewAsync()
        {
            try
            {
                // 每次运行用独立的 WebView2 用户数据目录：上一个实例刚关掉时 WebView2 可能还在收尾，
                // 共用固定目录会报 0x8007139F（组或资源的状态不是执行请求操作的正确状态）。
                var userDataRoot = Path.Combine(Settings.DataDir, "WebView2");
                var userData = Path.Combine(userDataRoot, "run-" + Process.GetCurrentProcess().Id);
                Directory.CreateDirectory(userData);
                try
                {
                    foreach (var dir in Directory.GetDirectories(userDataRoot, "run-*"))
                    {
                        if (string.Equals(dir, userData, StringComparison.OrdinalIgnoreCase)) continue;
                        try { Directory.Delete(dir, true); } catch { /* 旧进程可能还在用 */ }
                    }
                }
                catch { /* 忽略 */ }

                var browserFolder = FindBrowserFolder();
                var extraArgs = new List<string>
                {
                    // 编辑器预览里的游戏需要自动播放 BGM / 音效，不等用户先点一下页面。
                    "--autoplay-policy=no-user-gesture-required",
                };
                if (_options.DebugPort > 0)
                {
                    extraArgs.Add("--remote-debugging-port=" + _options.DebugPort);
                }
                var envOptions = new CoreWebView2EnvironmentOptions
                {
                    Language = "zh-CN",
                    AdditionalBrowserArguments = string.Join(" ", extraArgs),
                };
                _log.Info("webview2 browserFolder=" + (browserFolder ?? "(evergreen)"));
                var environment = await CoreWebView2Environment.CreateAsync(browserFolder, userData, envOptions);
                await _web.EnsureCoreWebView2Async(environment);

                var core = _web.CoreWebView2;
                core.Settings.AreDefaultContextMenusEnabled = _options.DevTools;
                core.Settings.AreDevToolsEnabled = _options.DevTools || _options.DebugPort > 0;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.IsZoomControlEnabled = false;
                core.Settings.AreBrowserAcceleratorKeysEnabled = true;
                core.Settings.IsWebMessageEnabled = true;
                core.Settings.AreDefaultScriptDialogsEnabled = true;

                core.WebMessageReceived += OnWebMessage;
                core.NewWindowRequested += OnNewWindowRequested;
                core.SetVirtualHostNameToFolderMapping(VirtualHost, _webRoot, CoreWebView2HostResourceAccessKind.Allow);

                _web.NavigationCompleted += (sender, args) =>
                {
                    _splash.Visible = false;
                    _web.Visible = true;
                    if (!args.IsSuccess) _log.Warn("navigation failed: " + args.WebErrorStatus);
                };

                _web.Source = new Uri(PickerUrl + "?v=" + DateTime.Now.Ticks);
                _log.Info("picker loaded");
            }
            catch (Exception error)
            {
                _log.Error("WebView2 init failed", error);
                _splash.Text = "内置浏览器启动失败：\r\n" + error.Message
                    + "\r\n\r\n请把游戏目录里的 webview2 文件夹（或系统安装 Microsoft Edge WebView2 运行时）准备好后重试。";
                _splash.ForeColor = Color.FromArgb(255, 160, 140);
            }
        }

        /// <summary>优先系统运行时（Evergreen），其次工具自带的 webview2、已知游戏目录的固定运行时。</summary>
        /// <summary>
        /// 运行时查找顺序：
        ///   1. --webview2 参数；
        ///   2. 工具目录自带 webview2（可选，有就优先，省得依赖系统）；
        ///   3. 上次用过的游戏目录、附近检测到的游戏目录里的 webview2（游戏包常见做法）；
        ///   4. 都没有 → 交给 WebView2 Loader 用系统 Evergreen 运行时。
        /// 第 4 步保证「选游戏目录」这个前置页面本身能打开：那时还没选目录，只能靠系统运行时。
        /// </summary>
        private string FindBrowserFolder()
        {
            if (IsBrowserFolder(_options.WebView2Folder))
            {
                _log.Info("webview2 source: --webview2 参数");
                return _options.WebView2Folder;
            }
            var candidates = new List<string>();
            candidates.Add(Path.Combine(_toolDir, "webview2"));
            if (!string.IsNullOrWhiteSpace(_options.GameDir)) candidates.Add(Path.Combine(_options.GameDir, "webview2"));
            if (!string.IsNullOrWhiteSpace(_settings.LastGame)) candidates.Add(Path.Combine(_settings.LastGame, "webview2"));
            foreach (var game in FindSuggestionGames()) candidates.Add(Path.Combine(game, "webview2"));
            foreach (var candidate in candidates)
            {
                if (IsBrowserFolder(candidate))
                {
                    _log.Info("webview2 source: " + candidate);
                    return candidate;
                }
            }
            _log.Info("webview2 source: 系统 Evergreen（未在工具/游戏目录找到固定版运行时）");
            if (!EvergreenInstalled())
            {
                _log.Warn("系统也未检测到 Evergreen WebView2 运行时，前置页面可能打不开");
            }
            return null;
        }

        /// <summary>系统是否装了 Evergreen WebView2（注册表判断，读不到就当没装）。</summary>
        private static bool EvergreenInstalled()
        {
            try
            {
                var view = Microsoft.Win32.Registry.GetValue(
                    @"HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
                    "pv", null) as string;
                if (!string.IsNullOrWhiteSpace(view) && view != "0.0.0.0") return true;
                view = Microsoft.Win32.Registry.GetValue(
                    @"HKEY_CURRENT_USER\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
                    "pv", null) as string;
                return !string.IsNullOrWhiteSpace(view) && view != "0.0.0.0";
            }
            catch { return false; }
        }

        private static bool IsBrowserFolder(string folder)
        {
            if (string.IsNullOrWhiteSpace(folder)) return false;
            try { return File.Exists(Path.Combine(folder, "msedge.dll")); } catch { return false; }
        }

        private void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs args)
        {
            args.Handled = true;
            OpenExternal(args.Uri);
        }

        private static void OpenExternal(string url)
        {
            if (string.IsNullOrWhiteSpace(url)) return;
            try
            {
                if (!url.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
                    && !url.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) return;
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            }
            catch { /* 忽略 */ }
        }

        // ─────────────────────────────────────────────────────────── 页面消息
        private void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs args)
        {
            Dictionary<string, object> message;
            try { message = _json.DeserializeObject(args.WebMessageAsJson) as Dictionary<string, object>; }
            catch (Exception error) { _log.Warn("bad web message: " + error.Message); return; }
            if (message == null) return;

            var type = Str(message, "type");
            switch (type)
            {
                case "picker:ready":
                    _lastPage = "picker";
                    if (_pendingStopNode)
                    {
                        _pendingStopNode = false;
                        Process old;
                        lock (_nodeLock)
                        {
                            old = _node;
                            _node = null;
                            _nodeStarting = false;
                        }
                        if (old != null)
                        {
                            // 目录页先显示出来，旧服务在后台收尾，不再让用户干等。
                            Task.Run((Action)(() => KillProcess(old)));
                        }
                    }
                    SendInit();
                    break;

                case "picker:list":
                    ListFolderAsync(Str(message, "path"));
                    break;

                case "picker:probe":
                    ProbeFolderAsync(Str(message, "path"));
                    break;

                case "picker:start":
                    StartNode(Str(message, "path"));
                    break;

                case "picker:cancel":
                    StopNode();
                    Send(new Dictionary<string, object> { { "type", "cancelled" } });
                    break;

                case "app:reselect":
                    _log.Info("reselect requested");
                    _options.GameDir = null;
                    _lastPage = "picker";
                    _pendingStopNode = _node != null;
                    // 立即离开编辑页；旧 Node/服务端在目录页显示后在后台关闭。
                    if (_web.CoreWebView2 != null)
                    {
                        _web.Source = new Uri(PickerUrl + "?v=" + DateTime.Now.Ticks + "&reselect=1");
                    }
                    break;

                case "app:quit":
                    // 页面内已经做过二次确认，宿主不再重复弹窗。
                    _confirmedClose = true;
                    Close();
                    break;

                case "app:openUrl":
                    {
                        var url = Str(message, "url");
                        if (url.StartsWith("https://nodejs.org", StringComparison.OrdinalIgnoreCase)
                            || url.StartsWith("https://go.microsoft.com", StringComparison.OrdinalIgnoreCase))
                        {
                            OpenExternal(url);
                        }
                        break;
                    }

                case "app:dsf":
                    ApplyDeviceScale(message);
                    break;

                case "app:screenshot":
                    CaptureScreenshot(message);
                    break;

                case "studio:ready":
                    _lastPage = "studio";
                    break;

                default:
                    _log.Warn("unknown web message: " + type);
                    break;
            }
        }

        private void SendInit()
        {
            var init = new Dictionary<string, object>
            {
                { "type", "init" },
                { "toolDir", _toolDir },
                { "version", HostVersion() },
                { "drives", ListDrives() },
                { "recent", _settings.Recent.ToArray() },
                { "lastGame", _settings.LastGame ?? "" },
                { "suggestions", FindSuggestionGames() },
                { "node", FindNodeSummary() },
                { "defaultPath", DefaultBrowsePath() },
            };
            Send(init);
        }

        private void Send(Dictionary<string, object> message)
        {
            try
            {
                if (_web.CoreWebView2 == null) return;
                _web.CoreWebView2.PostWebMessageAsJson(_json.Serialize(message));
            }
            catch (Exception error)
            {
                _log.Warn("post message failed: " + error.Message);
            }
        }

        /// <summary>手机端预览是 767×329 放大显示，用 WebView2 的 CDP 把该模式渲染 DPR 提到 2，避免放大发糊。</summary>
        private async void ApplyDeviceScale(Dictionary<string, object> message)
        {
            try
            {
                var core = _web.CoreWebView2;
                if (core == null) return;

                double dsf;
                if (!double.TryParse(Str(message, "dsf"), System.Globalization.NumberStyles.Float,
                        System.Globalization.CultureInfo.InvariantCulture, out dsf) || dsf <= 0)
                {
                    dsf = 1;
                }
                if (dsf <= 1.01)
                {
                    await core.CallDevToolsProtocolMethodAsync("Emulation.clearDeviceMetricsOverride", "{}");
                    return;
                }

                int width;
                int height;
                int.TryParse(Str(message, "width"), out width);
                int.TryParse(Str(message, "height"), out height);
                if (width <= 0) width = Math.Max(1, _web.Width);
                if (height <= 0) height = Math.Max(1, _web.Height);

                var dsfText = dsf.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture);
                var json = "{\"width\":" + width + ",\"height\":" + height
                    + ",\"deviceScaleFactor\":" + dsfText + ",\"mobile\":false}";
                await core.CallDevToolsProtocolMethodAsync("Emulation.setDeviceMetricsOverride", json);
                _log.Info("deviceScaleFactor=" + dsfText + " (" + width + "x" + height + ")");
            }
            catch (Exception error)
            {
                _log.Warn("deviceScaleFactor failed: " + error.Message);
            }
        }

        private static double Num(Dictionary<string, object> map, string key)
        {
            double value;
            return double.TryParse(Str(map, key), System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out value) ? value : 0;
        }

        /// <summary>只截取左侧游戏画面（页面传来的 iframe 矩形），保存并复制到剪贴板。</summary>
        private async void CaptureScreenshot(Dictionary<string, object> message)
        {
            if (_web.CoreWebView2 == null) return;
            try
            {
                double x = Num(message, "x");
                double y = Num(message, "y");
                double width = Num(message, "width");
                double height = Num(message, "height");
                if (width < 8 || height < 8) throw new Exception("截图区域太小");

                var vw = (double)_web.Width;
                var vh = (double)_web.Height;
                x = Math.Max(0, Math.Min(x, Math.Max(0, vw - 8)));
                y = Math.Max(0, Math.Min(y, Math.Max(0, vh - 8)));
                width = Math.Min(width, vw - x);
                height = Math.Min(height, vh - y);

                var inv = System.Globalization.CultureInfo.InvariantCulture;
                var json = "{\"format\":\"png\",\"fromSurface\":true,\"captureBeyondViewport\":false,\"clip\":{"
                    + "\"x\":" + x.ToString("0.##", inv) + ",\"y\":" + y.ToString("0.##", inv)
                    + ",\"width\":" + width.ToString("0.##", inv) + ",\"height\":" + height.ToString("0.##", inv)
                    + ",\"scale\":1}}";
                var result = await _web.CoreWebView2.CallDevToolsProtocolMethodAsync("Page.captureScreenshot", json);
                var data = _json.DeserializeObject(result) as Dictionary<string, object>;
                var base64 = data != null ? Str(data, "data") : string.Empty;
                if (string.IsNullOrWhiteSpace(base64)) throw new Exception("没有拿到截图数据");

                var bytes = Convert.FromBase64String(base64);
                var dir = Path.Combine(Settings.DataDir, "shots");
                Directory.CreateDirectory(dir);
                var file = Path.Combine(dir, "shot-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".png");
                File.WriteAllBytes(file, bytes);

                using (var ms = new MemoryStream(bytes))
                using (var image = Image.FromStream(ms))
                using (var bitmap = new Bitmap(image))
                {
                    var copied = false;
                    for (var i = 0; i < 5 && !copied; i++)
                    {
                        try
                        {
                            // copy:true 让剪贴板持有一份数据，位图 Dispose 后图片仍可粘贴。
                            Clipboard.SetDataObject(bitmap, true);
                            copied = true;
                        }
                        catch { Thread.Sleep(40); }
                    }
                    if (!copied) throw new Exception("剪贴板被占用，图片已保存到 " + file);
                    _log.Info("screenshot " + file + " (" + bitmap.Width + "x" + bitmap.Height + ")");
                }

                Send(new Dictionary<string, object>
                {
                    { "type", "app:screenshot:done" },
                    { "ok", true },
                    { "file", Path.GetFileName(file) },
                    { "path", file },
                });
            }
            catch (Exception error)
            {
                _log.Warn("screenshot failed: " + error.Message);
                Send(new Dictionary<string, object>
                {
                    { "type", "app:screenshot:done" },
                    { "ok", false },
                    { "message", error.Message },
                });
            }
        }

        // ─────────────────────────────────────────────────────────── 目录浏览
        private List<Dictionary<string, object>> ListDrives()
        {
            var drives = new List<Dictionary<string, object>>();
            try
            {
                foreach (var drive in DriveInfo.GetDrives())
                {
                    try
                    {
                        if (!drive.IsReady) continue;
                        if (drive.DriveType != DriveType.Fixed && drive.DriveType != DriveType.Removable) continue;
                        drives.Add(new Dictionary<string, object>
                        {
                            { "name", drive.Name.TrimEnd('\\') },
                            { "path", drive.RootDirectory.FullName },
                            { "label", SafeVolumeLabel(drive) },
                        });
                    }
                    catch { /* 单个盘符跳过 */ }
                }
            }
            catch { /* 忽略 */ }
            return drives;
        }

        private static string SafeVolumeLabel(DriveInfo drive)
        {
            try { return drive.VolumeLabel ?? string.Empty; } catch { return string.Empty; }
        }

        private async Task ListFolderAsync(string rawPath)
        {
            var path = NormalizePath(rawPath);
            if (string.IsNullOrWhiteSpace(path)) path = DefaultBrowsePath();

            var payload = await Task.Run(() => ListFolder(path));
            Send(payload);
        }

        private Dictionary<string, object> ListFolder(string path)
        {
            var result = new Dictionary<string, object>
            {
                { "type", "listing" },
                { "path", path ?? "" },
                { "drives", ListDrives() },
            };
            if (string.IsNullOrWhiteSpace(path))
            {
                result["error"] = "没有可浏览的目录";
                return result;
            }

            string parent = null;
            bool isRoot = false;
            try
            {
                var full = Path.GetFullPath(path);
                var root = Path.GetPathRoot(full);
                isRoot = string.Equals(full.TrimEnd(Path.DirectorySeparatorChar), root.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase);
                if (!isRoot)
                {
                    var info = Directory.GetParent(full);
                    parent = info != null ? info.FullName : null;
                }
                path = full;
            }
            catch (Exception error)
            {
                result["error"] = "路径不可用：" + error.Message;
                return result;
            }

            result["path"] = path;
            result["parent"] = parent ?? "";
            result["isRoot"] = isRoot;

            var folders = new List<Dictionary<string, object>>();
            try
            {
                foreach (var dir in Directory.EnumerateDirectories(path))
                {
                    try
                    {
                        var name = Path.GetFileName(dir);
                        if (string.IsNullOrWhiteSpace(name)) continue;
                        if (IsNoiseFolder(name)) continue;
                        var attributes = File.GetAttributes(dir);
                        if ((attributes & FileAttributes.Hidden) != 0 || (attributes & FileAttributes.System) != 0) continue;
                        var info = ProbeQuick(dir);
                        folders.Add(new Dictionary<string, object>
                        {
                            { "name", name },
                            { "path", dir },
                            { "isGame", info.IsGame },
                            { "hasNode", info.HasNode },
                            { "hasWebview2", info.HasWebview2 },
                        });
                        if (folders.Count >= 500)
                        {
                            result["truncated"] = true;
                            break;
                        }
                    }
                    catch { /* 单个目录跳过 */ }
                }
            }
            catch (Exception error)
            {
                result["error"] = "读取目录失败：" + error.Message;
            }

            folders.Sort((a, b) =>
            {
                var aGame = (bool)a["isGame"];
                var bGame = (bool)b["isGame"];
                if (aGame != bGame) return aGame ? -1 : 1;
                return string.Compare((string)a["name"], (string)b["name"], StringComparison.CurrentCultureIgnoreCase);
            });
            result["folders"] = folders.ToArray();
            return result;
        }

        private static readonly HashSet<string> NoiseFolders = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "node_modules", ".git", ".svn", "$RECYCLE.BIN", "System Volume Information",
            "Config.Msi", "Recovery", "PerfLogs", "__pycache__", ".cache",
        };

        private static bool IsNoiseFolder(string name)
        {
            return NoiseFolders.Contains(name);
        }

        private sealed class QuickProbe
        {
            public bool IsGame;
            public bool HasNode;
            public bool HasWebview2;
        }

        private static QuickProbe ProbeQuick(string dir)
        {
            var probe = new QuickProbe();
            try
            {
                probe.IsGame = File.Exists(Path.Combine(dir, "public", "index.html"))
                    && (File.Exists(Path.Combine(dir, "server", "index.js"))
                        || File.Exists(Path.Combine(dir, "package.json"))
                        || Directory.Exists(Path.Combine(dir, "shared")));
                probe.HasNode = File.Exists(Path.Combine(dir, "node", "node.exe"));
                probe.HasWebview2 = File.Exists(Path.Combine(dir, "webview2", "msedge.dll"));
            }
            catch { /* 忽略 */ }
            return probe;
        }

        private async Task ProbeFolderAsync(string rawPath)
        {
            var path = NormalizePath(rawPath);
            var payload = await Task.Run(() => ProbeFolder(path));
            Send(payload);
        }

        private Dictionary<string, object> ProbeFolder(string path)
        {
            var result = new Dictionary<string, object> { { "type", "probe" }, { "path", path ?? "" } };
            if (string.IsNullOrWhiteSpace(path)) { result["error"] = "没有选择目录"; return result; }
            try
            {
                var full = Path.GetFullPath(path);
                result["path"] = full;
                if (!Directory.Exists(full)) { result["error"] = "目录不存在"; result["valid"] = false; return result; }

                var hasIndex = File.Exists(Path.Combine(full, "public", "index.html"));
                var hasServer = File.Exists(Path.Combine(full, "server", "index.js"));
                var hasShared = Directory.Exists(Path.Combine(full, "shared"));
                var hasPkg = File.Exists(Path.Combine(full, "package.json"));
                var hasNode = File.Exists(Path.Combine(full, "node", "node.exe"));
                var hasWebview2 = IsBrowserFolder(Path.Combine(full, "webview2"));
                var pkgName = string.Empty;
                var pkgVersion = string.Empty;
                if (hasPkg)
                {
                    try
                    {
                        var pkg = _json.DeserializeObject(File.ReadAllText(Path.Combine(full, "package.json"))) as Dictionary<string, object>;
                        if (pkg != null)
                        {
                            pkgName = Str(pkg, "name");
                            pkgVersion = Str(pkg, "version");
                        }
                    }
                    catch { /* 忽略 */ }
                }

                var nodePath = FindNodePath(full);
                result["valid"] = hasIndex && (hasServer || hasShared || hasPkg);
                result["hasIndex"] = hasIndex;
                result["hasServer"] = hasServer;
                result["hasShared"] = hasShared;
                result["hasPkg"] = hasPkg;
                result["hasNode"] = hasNode;
                result["hasWebview2"] = hasWebview2;
                result["pkgName"] = pkgName;
                result["pkgVersion"] = pkgVersion;
                result["nodePath"] = nodePath ?? "";
                result["nodeOk"] = !string.IsNullOrWhiteSpace(nodePath);
            }
            catch (Exception error)
            {
                result["error"] = "检查目录失败：" + error.Message;
                result["valid"] = false;
            }
            return result;
        }

        private static string NormalizePath(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return null;
            var path = raw.Trim().Trim('"');
            if (path.Length == 2 && path[1] == ':') path += "\\";
            path = path.Replace('/', '\\');
            try { return Path.GetFullPath(path); } catch { return path; }
        }

        private string DefaultBrowsePath()
        {
            if (!string.IsNullOrWhiteSpace(_settings.LastGame) && Directory.Exists(_settings.LastGame)) return _settings.LastGame;
            var suggestions = FindSuggestionGames();
            if (suggestions.Count > 0) return Path.GetDirectoryName(suggestions[0]) ?? suggestions[0];
            try { return Path.GetPathRoot(_toolDir) ?? _toolDir; } catch { return _toolDir; }
        }

        /// <summary>工具目录的上两级里找现成的游戏目录（本工具和游戏通常是同级放着的）。</summary>
        private List<string> FindSuggestionGames()
        {
            var games = new List<string>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            Action<string> add = delegate(string dir)
            {
                if (string.IsNullOrWhiteSpace(dir) || !Directory.Exists(dir)) return;
                string full;
                try { full = Path.GetFullPath(dir).TrimEnd('\\'); } catch { return; }
                if (!seen.Add(full)) return;
                if (File.Exists(Path.Combine(full, "public", "index.html"))
                    && (File.Exists(Path.Combine(full, "server", "index.js")) || Directory.Exists(Path.Combine(full, "shared"))))
                {
                    // “.before-rollback / backup / old” 目录不作为首选，避免误选备份。
                    var folderName = Path.GetFileName(full).ToLowerInvariant();
                    if (folderName.Contains("before-rollback") || folderName.Contains("backup")
                        || folderName.Contains(".bak") || folderName.Contains("before-"))
                    {
                        return;
                    }
                    games.Add(full);
                }
            };

            add(_options.GameDir);
            add(_toolDir);

            string scan = _toolDir;
            for (var level = 0; level < 3 && !string.IsNullOrWhiteSpace(scan); level++)
            {
                try
                {
                    var parent = Path.GetDirectoryName(scan);
                    if (string.IsNullOrWhiteSpace(parent)) break;
                    foreach (var child in Directory.EnumerateDirectories(parent))
                    {
                        add(child);
                        if (games.Count >= 8) break;
                    }
                    scan = parent;
                }
                catch { break; }
                if (games.Count >= 8) break;
            }
            return games;
        }

        // ─────────────────────────────────────────────────────────── Node
        private Dictionary<string, object> FindNodeSummary()
        {
            var path = FindNodePath(_settings.LastGame);
            return new Dictionary<string, object>
            {
                { "found", !string.IsNullOrWhiteSpace(path) },
                { "path", path ?? "" },
            };
        }

        private string FindNodePath(string gameDir)
        {
            var candidates = new List<string>();
            if (!string.IsNullOrWhiteSpace(gameDir)) candidates.Add(Path.Combine(gameDir, "node", "node.exe"));
            candidates.Add(Path.Combine(_toolDir, "node", "node.exe"));
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"));
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe"));
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs", "node.exe"));

            foreach (var candidate in candidates)
            {
                try { if (File.Exists(candidate)) return candidate; } catch { /* 忽略 */ }
            }

            try
            {
                var pathVar = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
                foreach (var part in pathVar.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries))
                {
                    try
                    {
                        var candidate = Path.Combine(part.Trim(), "node.exe");
                        if (File.Exists(candidate)) return candidate;
                    }
                    catch { /* 忽略 */ }
                }
            }
            catch { /* 忽略 */ }

            return null;
        }

        private void StartNode(string rawPath)
        {
            if (_nodeStarting) return;
            var path = NormalizePath(rawPath);
            if (string.IsNullOrWhiteSpace(path) || !Directory.Exists(path))
            {
                Send(new Dictionary<string, object> { { "type", "error" }, { "message", "目录不存在：" + rawPath } });
                return;
            }
            var probe = ProbeFolder(path);
            if (!(bool)probe["valid"])
            {
                Send(new Dictionary<string, object>
                {
                    { "type", "error" },
                    { "message", "这不是游戏目录。要选包含 public\\index.html 和 server\\ 的那一层。" },
                });
                return;
            }

            var nodePath = FindNodePath(path);
            if (string.IsNullOrWhiteSpace(nodePath))
            {
                Send(new Dictionary<string, object>
                {
                    { "type", "error" },
                    { "code", "node-missing" },
                    { "message", "没有找到 Node.js。这个游戏包一般自带 node\\node.exe；也可以安装 Node.js 22 或更高版本后重试。" },
                });
                return;
            }

            StopNode();
            _nodeStarting = true;
            _pendingStudioUrl = null;
            _nodeExitedCode = -1;
            _settings.LastGame = path;
            _settings.AddRecent(path);
            _settings.Save();

            var appPath = Path.Combine(_toolDir, "app.mjs");
            if (!File.Exists(appPath))
            {
                _nodeStarting = false;
                Send(new Dictionary<string, object> { { "type", "error" }, { "message", "缺少 app.mjs：" + appPath } });
                return;
            }

            Send(new Dictionary<string, object>
            {
                { "type", "starting" },
                { "path", path },
                { "nodePath", nodePath },
            });
            _log.Info("starting node: " + nodePath + " --game " + path);

            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = nodePath,
                    Arguments = Quote(appPath) + " --embedded --game " + Quote(path),
                    WorkingDirectory = _toolDir,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
                };
                psi.EnvironmentVariables["NO_COLOR"] = "1";
                psi.EnvironmentVariables["FORCE_COLOR"] = "0";

                var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
                process.OutputDataReceived += (sender, args) => OnNodeLine(args.Data, false);
                process.ErrorDataReceived += (sender, args) => OnNodeLine(args.Data, true);
                process.Exited += (sender, args) => OnNodeExited(process);
                _node = process;
                process.Start();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
            }
            catch (Exception error)
            {
                _log.Error("node start failed", error);
                _nodeStarting = false;
                _node = null;
                Send(new Dictionary<string, object>
                {
                    { "type", "error" },
                    { "code", "node-start" },
                    { "message", "启动 Node 失败：" + error.Message },
                });
            }
        }

        private void OnNodeLine(string line, bool stderr)
        {
            if (line == null) return;
            // Node 的 stdout 事件在后台线程触发；WebView2 的消息发送必须在 UI 线程。
            if (InvokeRequired)
            {
                try { BeginInvoke((Action)(() => OnNodeLine(line, stderr))); } catch { /* 窗口已关 */ }
                return;
            }
            line = StripAnsi(line).TrimEnd();
            if (line.Length == 0) return;
            _log.Info((stderr ? "[node:err] " : "[node] ") + line);

            if (line.StartsWith("{", StringComparison.Ordinal) && line.IndexOf("\"event\"", StringComparison.Ordinal) >= 0)
            {
                Dictionary<string, object> evt;
                try { evt = _json.DeserializeObject(line) as Dictionary<string, object>; }
                catch { evt = null; }
                if (evt != null)
                {
                    var eventName = Str(evt, "event");
                    switch (eventName)
                    {
                        case "step":
                            Send(new Dictionary<string, object>
                            {
                                { "type", "step" },
                                { "key", Str(evt, "key") },
                                { "label", Str(evt, "label") },
                                { "state", Str(evt, "state") },
                                { "detail", Str(evt, "detail") },
                            });
                            return;
                        case "log":
                            Send(new Dictionary<string, object> { { "type", "log" }, { "line", Str(evt, "line") } });
                            return;
                        case "ready":
                            {
                                var url = Str(evt, "url");
                                _pendingStudioUrl = url;
                                _nodeStarting = false;
                                Send(new Dictionary<string, object>
                                {
                                    { "type", "ready" },
                                    { "url", url },
                                    { "gameDir", Str(evt, "gameDir") },
                                    { "version", Str(evt, "version") },
                                });
                                var timer = new System.Windows.Forms.Timer { Interval = 700 };
                                timer.Tick += (sender, args) =>
                                {
                                    timer.Stop();
                                    timer.Dispose();
                                    BeginInvoke((Action)(() => NavigateStudio(url)));
                                };
                                timer.Start();
                                return;
                            }
                        case "error":
                            _nodeStarting = false;
                            Send(new Dictionary<string, object>
                            {
                                { "type", "error" },
                                { "code", Str(evt, "code") },
                                { "message", Str(evt, "message") },
                            });
                            if (_lastPage == "studio")
                            {
                                Send(new Dictionary<string, object> { { "type", "app:stopped" }, { "code", -1 }, { "message", Str(evt, "message") } });
                            }
                            return;
                        default:
                            Send(new Dictionary<string, object> { { "type", "log" }, { "line", line } });
                            return;
                    }
                }
            }

            if (_lastPage == "picker")
            {
                Send(new Dictionary<string, object> { { "type", "log" }, { "line", line } });
            }
        }

        private void NavigateStudio(string url)
        {
            if (string.IsNullOrWhiteSpace(url) || _web.CoreWebView2 == null) return;
            _lastPage = "studio";
            _log.Info("navigate studio: " + url);
            try { _web.Source = new Uri(url); }
            catch (Exception error) { _log.Error("studio navigate failed", error); }
        }

        private void OnNodeExited(Process source)
        {
            var code = -1;
            try { if (source != null) code = source.ExitCode; } catch { /* 忽略 */ }
            if (source != _node)
            {
                // 主动停止/切换目录时的旧进程退出，不要误报错误。
                _log.Info("stale node exited: " + code);
                return;
            }
            _nodeExitedCode = code;
            try
            {
                BeginInvoke((Action)(() =>
                {
                _log.Warn("node exited: " + code);
                if (_shuttingDown) return;
                _nodeStarting = false;
                if (_lastPage == "studio")
                {
                    Send(new Dictionary<string, object>
                    {
                        { "type", "app:stopped" },
                        { "code", code },
                        { "message", "编辑服务已停止（退出码 " + code + "）。" },
                    });
                }
                else
                {
                    Send(new Dictionary<string, object>
                    {
                        { "type", "error" },
                        { "code", "node-exit" },
                        { "message", "启动过程中 Node 退出了（退出码 " + code + "）。看上面的日志，或换一个游戏目录重试。" },
                    });
                }
                }));
            }
            catch { /* 窗口已关 */ }
        }

        private void StopNode()
        {
            Process process;
            lock (_nodeLock)
            {
                process = _node;
                _node = null;
                _nodeStarting = false;
            }
            if (process != null) KillProcess(process);
        }

        private void KillProcess(Process process)
        {
            if (process == null) return;
            try
            {
                if (!process.HasExited)
                {
                    try
                    {
                        process.StandardInput.WriteLine("shutdown");
                        process.StandardInput.Flush();
                        process.StandardInput.Close();
                    }
                    catch { /* 进程可能已经没了 */ }
                    if (!process.WaitForExit(1800))
                    {
                        try
                        {
                            var kill = Process.Start(new ProcessStartInfo("taskkill", "/PID " + process.Id + " /T /F")
                            {
                                UseShellExecute = false,
                                CreateNoWindow = true,
                                WindowStyle = ProcessWindowStyle.Hidden,
                            });
                            if (kill != null) kill.WaitForExit(3000);
                        }
                        catch { /* 忽略 */ }
                    }
                }
            }
            catch { /* 忽略 */ }
            try { process.Dispose(); } catch { /* 忽略 */ }
        }

        private static string Quote(string value)
        {
            return "\"" + (value ?? string.Empty).Replace("\"", "\\\"") + "\"";
        }

        private static readonly Regex Ansi = new Regex("\u001b\\[[0-9;]*[A-Za-z]", RegexOptions.Compiled);
        private static string StripAnsi(string text)
        {
            return string.IsNullOrEmpty(text) ? text : Ansi.Replace(text, string.Empty);
        }

        private static string Str(Dictionary<string, object> map, string key)
        {
            object value;
            if (map == null || !map.TryGetValue(key, out value) || value == null) return string.Empty;
            return Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty;
        }

        private static string HostVersion()
        {
            try { return typeof(Program).Assembly.GetName().Version.ToString(3); } catch { return "1.2.1"; }
        }

        // ─────────────────────────────────────────────────────────── 窗口
        private void ApplySavedBounds()
        {
            if (_settings.Width >= 900 && _settings.Height >= 600)
            {
                var bounds = new Rectangle(_settings.X, _settings.Y, _settings.Width, _settings.Height);
                var screen = Screen.AllScreens.FirstOrDefault(s => s.WorkingArea.IntersectsWith(bounds));
                if (screen != null)
                {
                    StartPosition = FormStartPosition.Manual;
                    Bounds = bounds;
                }
            }
        }

        private void OnFormClosing(object sender, FormClosingEventArgs args)
        {
            // 原生标题栏 × / Alt+F4 也先二次确认（编辑页内已经确认过的会带 _confirmedClose）。
            if (!_confirmedClose && _lastPage == "studio")
            {
                var result = MessageBox.Show(this,
                    "确定关闭编辑器吗？\r\n未保存的修改会丢失。",
                    "退出编辑器",
                    MessageBoxButtons.OKCancel,
                    MessageBoxIcon.Question);
                if (result != DialogResult.OK)
                {
                    args.Cancel = true;
                    return;
                }
            }
            _confirmedClose = true;
            _shuttingDown = true;
            _log.Info("host closing");
            try
            {
                if (WindowState == FormWindowState.Normal)
                {
                    _settings.X = Bounds.X;
                    _settings.Y = Bounds.Y;
                    _settings.Width = Bounds.Width;
                    _settings.Height = Bounds.Height;
                }
                _settings.Maximized = WindowState == FormWindowState.Maximized;
                _settings.Save();
            }
            catch { /* 忽略 */ }
            StopNode();
        }
    }

    // ─────────────────────────────────────────────────────────── 设置 / 日志
    internal sealed class Settings
    {
        public static string DataDir
        {
            get
            {
                var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StrongholdUIEditor");
                Directory.CreateDirectory(dir);
                return dir;
            }
        }

        public string LastGame = string.Empty;
        public List<string> Recent = new List<string>();
        public int X = -1;
        public int Y = -1;
        public int Width;
        public int Height;
        public bool Maximized;

        private static string FilePath
        {
            get { return Path.Combine(DataDir, "settings.json"); }
        }

        public static Settings Load()
        {
            try
            {
                if (File.Exists(FilePath))
                {
                    var json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
                    var data = json.DeserializeObject(File.ReadAllText(FilePath)) as Dictionary<string, object>;
                    if (data != null)
                    {
                        var settings = new Settings();
                        settings.LastGame = Get(data, "lastGame");
                        settings.X = GetInt(data, "x", -1);
                        settings.Y = GetInt(data, "y", -1);
                        settings.Width = GetInt(data, "width", 0);
                        settings.Height = GetInt(data, "height", 0);
                        settings.Maximized = GetBool(data, "maximized");
                        object recent;
                        if (data.TryGetValue("recent", out recent) && recent is object[])
                        {
                            foreach (var item in (object[])recent)
                            {
                                var text = Convert.ToString(item);
                                if (!string.IsNullOrWhiteSpace(text)) settings.Recent.Add(text);
                            }
                        }
                        return settings;
                    }
                }
            }
            catch { /* 坏文件就当新装 */ }
            return new Settings();
        }

        public void AddRecent(string dir)
        {
            if (string.IsNullOrWhiteSpace(dir)) return;
            Recent.RemoveAll(item => string.Equals(item, dir, StringComparison.OrdinalIgnoreCase));
            Recent.Insert(0, dir);
            while (Recent.Count > 8) Recent.RemoveAt(Recent.Count - 1);
        }

        public void Save()
        {
            try
            {
                var json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
                var data = new Dictionary<string, object>
                {
                    { "lastGame", LastGame ?? string.Empty },
                    { "recent", Recent.ToArray() },
                    { "x", X },
                    { "y", Y },
                    { "width", Width },
                    { "height", Height },
                    { "maximized", Maximized },
                };
                File.WriteAllText(FilePath, json.Serialize(data), new UTF8Encoding(false));
            }
            catch { /* 忽略 */ }
        }

        private static string Get(Dictionary<string, object> data, string key)
        {
            object value;
            return data.TryGetValue(key, out value) && value != null ? Convert.ToString(value) ?? string.Empty : string.Empty;
        }

        private static int GetInt(Dictionary<string, object> data, string key, int fallback)
        {
            object value;
            if (!data.TryGetValue(key, out value) || value == null) return fallback;
            int result;
            return int.TryParse(Convert.ToString(value), out result) ? result : fallback;
        }

        private static bool GetBool(Dictionary<string, object> data, string key)
        {
            object value;
            if (!data.TryGetValue(key, out value) || value == null) return false;
            bool result;
            return bool.TryParse(Convert.ToString(value), out result) && result;
        }
    }

    internal sealed class LogFile
    {
        private readonly string _path;
        private readonly object _lock = new object();

        public LogFile(string path)
        {
            _path = path;
            try { Directory.CreateDirectory(Path.GetDirectoryName(path)); } catch { /* 忽略 */ }
            try
            {
                if (File.Exists(path) && new FileInfo(path).Length > 1024 * 1024)
                {
                    File.Move(path, path + ".old");
                }
            }
            catch { /* 忽略 */ }
        }

        public void Info(string message)
        {
            Write("INFO", message, null);
        }

        public void Warn(string message)
        {
            Write("WARN", message, null);
        }

        public void Error(string message, Exception error = null)
        {
            Write("ERROR", message, error);
        }

        private void Write(string level, string message, Exception error)
        {
            var line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " [" + level + "] " + message;
            if (error != null) line += "\r\n" + error;
            lock (_lock)
            {
                try { File.AppendAllText(_path, line + "\r\n", new UTF8Encoding(false)); } catch { /* 忽略 */ }
            }
            Debug.WriteLine(line);
        }
    }
}
