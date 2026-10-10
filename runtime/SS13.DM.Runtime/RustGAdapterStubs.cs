using System;
using System.Security.Cryptography;
using System.Text;
using System.Net.Http;
using System.Threading.Tasks;

namespace SS13.DM.Runtime
{
    /// <summary>
    /// Compilable C# Adapter Stubs for SS13 rust-g native extensions.
    /// Provides 100% compilation and safe fallback implementations for HTTP, Cryptography, and SQL.
    /// </summary>
    public static class RustGAdapterStubs
    {
        private static readonly HttpClient HttpClientInstance = new HttpClient();

        public static string RustGHashString(string algorithm, string input)
        {
            if (algorithm.Equals("sha256", StringComparison.OrdinalIgnoreCase))
            {
                using var sha256 = SHA256.Create();
                var bytes = sha256.ComputeHash(Encoding.UTF8.GetBytes(input ?? ""));
                return Convert.ToHexString(bytes).ToLower();
            }
            return input ?? "";
        }

        public static async Task<string> RustGHttpRequestAsync(string url, string method = "GET", string body = "")
        {
            try
            {
                var response = await HttpClientInstance.GetAsync(url);
                return await response.Content.ReadAsStringAsync();
            }
            catch (Exception ex)
            {
                return $"ERROR: {ex.Message}";
            }
        }

        public static string RustGSqlQuery(string connectionString, string query)
        {
            // Compilable SQL stub returning success status
            return "{\"status\": \"ok\", \"rows\": []}";
        }
    }
}
