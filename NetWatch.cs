using System;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Diagnostics;

class Program
{
    static void Main(string[] args)
    {
        int port = 5500;
        string url = "http://localhost:" + port + "/";
        string rootDir = AppDomain.CurrentDomain.BaseDirectory;

        HttpListener listener = new HttpListener();
        listener.Prefixes.Add(url);

        try
        {
            listener.Start();
            Console.WriteLine("========================================");
            Console.WriteLine("    NetWatch Device Monitor Server");
            Console.WriteLine("========================================");
            Console.WriteLine("Listening on: " + url);
            Console.WriteLine("Serving files from: " + rootDir);
            Console.WriteLine("Proxy endpoint: " + url + "proxy?url=...");
            Console.WriteLine("Press Ctrl+C to stop.");
            
            // Open default browser
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });

            while (true)
            {
                HttpListenerContext context = listener.GetContext();
                ThreadPool.QueueUserWorkItem(o => HandleRequest(context, rootDir));
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("Failed to start server. Port may be in use.");
            Console.WriteLine(ex.Message);
            Console.ReadLine();
        }
    }

    static void HandleRequest(HttpListenerContext ctx, string rootDir)
    {
        HttpListenerRequest req = ctx.Request;
        HttpListenerResponse res = ctx.Response;
        
        try
        {
            string path = req.Url.LocalPath;

            // CORS Headers
            res.AddHeader("Access-Control-Allow-Origin", "*");
            res.AddHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.AddHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

            if (req.HttpMethod == "OPTIONS")
            {
                res.StatusCode = 200;
                res.Close();
                return;
            }

            if (path.StartsWith("/proxy"))
            {
                HandleProxy(req, res);
                return;
            }

            if (path == "/") path = "/index.html";
            string filePath = Path.Combine(rootDir, path.TrimStart('/'));

            if (File.Exists(filePath))
            {
                byte[] fileBytes = File.ReadAllBytes(filePath);
                if (path.EndsWith(".html")) res.ContentType = "text/html; charset=utf-8";
                else if (path.EndsWith(".js")) res.ContentType = "application/javascript; charset=utf-8";
                else if (path.EndsWith(".css")) res.ContentType = "text/css; charset=utf-8";
                else res.ContentType = "application/octet-stream";

                res.StatusCode = 200;
                res.ContentLength64 = fileBytes.Length;
                res.OutputStream.Write(fileBytes, 0, fileBytes.Length);
            }
            else
            {
                res.StatusCode = 404;
                byte[] err = Encoding.UTF8.GetBytes("Not Found");
                res.OutputStream.Write(err, 0, err.Length);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("Error serving: " + ex.Message);
            res.StatusCode = 500;
        }
        finally
        {
            try { res.Close(); } catch {}
        }
    }

    static void HandleProxy(HttpListenerRequest req, HttpListenerResponse res)
    {
        string targetUrl = req.QueryString["url"];
        if (string.IsNullOrEmpty(targetUrl))
        {
            res.StatusCode = 400;
            byte[] err = Encoding.UTF8.GetBytes("Missing url parameter");
            res.OutputStream.Write(err, 0, err.Length);
            return;
        }

        string auth = req.QueryString["auth"];

        try
        {
            HttpWebRequest proxyReq = (HttpWebRequest)WebRequest.Create(targetUrl);
            proxyReq.Method = req.HttpMethod;
            proxyReq.Timeout = 5000;
            proxyReq.UserAgent = "NetWatch/1.0";
            
            if (!string.IsNullOrEmpty(auth))
            {
                proxyReq.Headers["Authorization"] = "Basic " + auth;
            }

            if (req.ContentType != null)
            {
                proxyReq.ContentType = req.ContentType;
            }

            if (req.HttpMethod == "POST" && req.HasEntityBody)
            {
                using (Stream instream = req.InputStream)
                using (MemoryStream ms = new MemoryStream())
                {
                    instream.CopyTo(ms);
                    byte[] reqData = ms.ToArray();
                    proxyReq.ContentLength = reqData.Length;
                    using (Stream outstream = proxyReq.GetRequestStream())
                    {
                        outstream.Write(reqData, 0, reqData.Length);
                    }
                }
            }

            using (HttpWebResponse proxyRes = (HttpWebResponse)proxyReq.GetResponse())
            {
                res.StatusCode = (int)proxyRes.StatusCode;
                if (proxyRes.ContentType != null) res.ContentType = proxyRes.ContentType;

                using (Stream stream = proxyRes.GetResponseStream())
                using (MemoryStream ms = new MemoryStream())
                {
                    stream.CopyTo(ms);
                    byte[] data = ms.ToArray();
                    res.ContentLength64 = data.Length;
                    res.OutputStream.Write(data, 0, data.Length);
                }
            }
        }
        catch (WebException wex)
        {
            string errMsg = "proxy error";
            res.StatusCode = 502;
            
            if (wex.Response != null)
            {
                HttpWebResponse r = (HttpWebResponse)wex.Response;
                res.StatusCode = (int)r.StatusCode;
                try
                {
                    using (Stream s = r.GetResponseStream())
                    using (StreamReader sr = new StreamReader(s))
                    {
                        errMsg = sr.ReadToEnd();
                    }
                } catch {}
            }
            
            byte[] b = Encoding.UTF8.GetBytes(errMsg);
            res.ContentLength64 = b.Length;
            res.OutputStream.Write(b, 0, b.Length);
        }
        catch (Exception ex)
        {
            res.StatusCode = 502;
            byte[] b = Encoding.UTF8.GetBytes("proxy internal error: " + ex.Message);
            res.ContentLength64 = b.Length;
            res.OutputStream.Write(b, 0, b.Length);
        }
    }
}
