import Foundation
import Security

/// Where the Switchback server is and the key for it. Set in Settings › Account & sync (the key is kept in the
/// Keychain); a local build can fill in defaults from `Config/Secrets.xcconfig` (gitignored), which end up in
/// Info.plist as `SwitchbackServerURL` / `SwitchbackAPIKey`. Nothing is built into the app from CI.
enum ServerConfig {
    static let urlKey = "server.url"
    static let enabledKey = "server.enabled"
    private static let keychainAccount = "switchback-server-api-key"

    static var baseURL: URL? {
        let stored = UserDefaults.standard.string(forKey: urlKey)
        let raw = (stored?.isEmpty == false ? stored : infoValue("SwitchbackServerURL")) ?? ""
        return normalized(raw)
    }

    /// Accepts "host", "host/" or "https://host"; the server is HTTPS only.
    static func normalized(_ raw: String) -> URL? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.contains("://") { s = "https://" + s }
        while s.hasSuffix("/") { s.removeLast() }
        guard let u = URL(string: s), u.scheme == "https", u.host?.isEmpty == false else { return nil }
        return u
    }

    static var apiKey: String? {
        if let k = Keychain.read(keychainAccount), !k.isEmpty { return k }
        return infoValue("SwitchbackAPIKey")
    }

    static func setAPIKey(_ key: String) {
        let k = key.trimmingCharacters(in: .whitespacesAndNewlines)
        if k.isEmpty { Keychain.delete(keychainAccount) } else { Keychain.write(k, account: keychainAccount) }
    }

    static var isEnabled: Bool { UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true }

    static var isConfigured: Bool { baseURL != nil && apiKey != nil }

    /// Identifies the server and key in use, so pointing the app at a different one starts a fresh first sync.
    static var fingerprint: String { "\(baseURL?.absoluteString ?? "")#\(apiKey?.suffix(8) ?? "")" }

    private static func infoValue(_ key: String) -> String? {
        guard let v = Bundle.main.object(forInfoDictionaryKey: key) as? String else { return nil }
        let t = v.trimmingCharacters(in: .whitespacesAndNewlines)
        // an unset build setting arrives empty (or as its literal "$(NAME)" in some setups)
        return t.isEmpty || t.hasPrefix("$(") ? nil : t
    }
}

enum Keychain {
    private static let service = "com.cadewardc.switchback"

    static func read(_ account: String) -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: account, kSecReturnData as String: true,
                                kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }

    static func write(_ value: String, account: String) {
        delete(account)
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: account, kSecValueData as String: Data(value.utf8),
                                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock]
        SecItemAdd(q as CFDictionary, nil)
    }

    static func delete(_ account: String) {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: account]
        SecItemDelete(q as CFDictionary)
    }
}

enum ServerError: LocalizedError {
    case notConfigured
    case offline
    case status(Int, String?)
    case tooLarge(Int)
    case badResponse

    var errorDescription: String? {
        switch self {
        case .notConfigured: return "Sign in under Settings › Account & sync to use the server."
        case .offline: return "No connection to the server. Changes are kept on the phone and sync when it's back."
        case .status(401, _): return "The server didn't accept the API key. Check it in Settings › Account & sync."
        case .status(403, _):
            return "The request was blocked before it reached the server (Cloudflare answered 403). Check the tunnel's security settings for this host."
        case .status(413, _): return "An item is too big for the server (the limit is about 2 MB)."
        case .status(let code, let msg): return "The server answered \(code)\(msg.map { ": \($0)" } ?? "")."
        case .tooLarge(let bytes):
            return "An item is too big to upload (\(ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)); the limit is about 2 MB)."
        case .badResponse: return "The server sent something unexpected."
        }
    }

    var isOffline: Bool { if case .offline = self { return true } else { return false } }
}

/// Decodes a value, or leaves it nil if it doesn't fit (so one odd document can't break a whole list).
struct Lossy<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

/// A document as the server returns it: `{"id","updated_at","deleted","data"}`.
struct ServerDocument<T: Decodable>: Decodable {
    let id: String
    let updatedAt: Int64
    let deleted: Bool
    private let raw: Lossy<T>?

    var data: T? { raw?.value }

    private enum CodingKeys: String, CodingKey { case id, updatedAt = "updated_at", deleted, raw = "data" }
}

struct ServerList<T: Decodable>: Decodable {
    let items: [ServerDocument<T>]
    let serverTime: Int64

    private enum CodingKeys: String, CodingKey { case items, serverTime = "server_time" }
}

private struct PutAck: Decodable { let updated_at: Int64 }
private struct ErrorBody: Decodable { let error: String }

/// The server's API: collections of JSON documents addressed by id.
struct ServerClient {
    let baseURL: URL
    let apiKey: String
    var session: URLSession = .shared

    static let maxBody = 2_000_000

    static func current() throws -> ServerClient {
        guard let u = ServerConfig.baseURL, let k = ServerConfig.apiKey else { throw ServerError.notConfigured }
        return ServerClient(baseURL: u, apiKey: k)
    }

    /// Names and ids: 1-128 of A-Z a-z 0-9 _ - .
    static func isValidName(_ s: String) -> Bool {
        (1...128).contains(s.utf8.count) && s.utf8.allSatisfy { b in
            (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b == 0x5f || b == 0x2d || b == 0x2e
        }
    }

    /// GET /health, no key needed.
    func health() async throws {
        var r = URLRequest(url: baseURL.appendingPathComponent("health"), timeoutInterval: 10)
        r.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, resp) = try await send(r)
        guard resp.statusCode == 200, String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines) == "ok" else {
            throw ServerError.status(resp.statusCode, nil)
        }
    }

    /// Every live document, or with `since`, everything changed after it (deletions included).
    func list<T: Decodable>(_ collection: String, as type: T.Type, since: Int64? = nil) async throws -> ServerList<T> {
        var comps = URLComponents(url: path(collection), resolvingAgainstBaseURL: false)!
        if let since { comps.queryItems = [URLQueryItem(name: "since", value: String(since))] }
        let (data, _) = try await authed(URLRequest(url: comps.url!, timeoutInterval: 60))
        do { return try JSONDecoder().decode(ServerList<T>.self, from: data) } catch { throw ServerError.badResponse }
    }

    func get<T: Decodable>(_ collection: String, _ id: String, as type: T.Type) async throws -> ServerDocument<T>? {
        do {
            let (data, _) = try await authed(URLRequest(url: path(collection, id), timeoutInterval: 30))
            return try JSONDecoder().decode(ServerDocument<T>.self, from: data)
        } catch ServerError.status(404, _) {
            return nil
        }
    }

    @discardableResult
    func put<T: Encodable>(_ collection: String, _ id: String, _ body: T) async throws -> Int64 {
        let data = try JSONEncoder().encode(body)
        guard data.count <= Self.maxBody else { throw ServerError.tooLarge(data.count) }
        var r = URLRequest(url: path(collection, id), timeoutInterval: 60)
        r.httpMethod = "PUT"
        r.httpBody = data
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (out, _) = try await authed(r)
        return (try? JSONDecoder().decode(PutAck.self, from: out).updated_at) ?? 0
    }

    func delete(_ collection: String, _ id: String) async throws {
        var r = URLRequest(url: path(collection, id), timeoutInterval: 30)
        r.httpMethod = "DELETE"
        do { _ = try await authed(r) } catch ServerError.status(404, _) { /* already gone */ }
    }

    // MARK: -

    private func path(_ collection: String, _ id: String? = nil) -> URL {
        var u = baseURL.appendingPathComponent("v1").appendingPathComponent(collection)
        if let id { u = u.appendingPathComponent(id) }
        return u
    }

    private func authed(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        var r = request
        r.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        r.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, resp) = try await send(r)
        guard (200..<300).contains(resp.statusCode) else {
            throw ServerError.status(resp.statusCode, (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error)
        }
        return (data, resp)
    }

    private func send(_ r: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, resp) = try await session.data(for: r)
            guard let http = resp as? HTTPURLResponse else { throw ServerError.badResponse }
            return (data, http)
        } catch let e as URLError where Self.offlineCodes.contains(e.code) {
            throw ServerError.offline
        }
    }

    private static let offlineCodes: Set<URLError.Code> = [
        .notConnectedToInternet, .networkConnectionLost, .timedOut, .cannotFindHost, .cannotConnectToHost,
        .dnsLookupFailed, .dataNotAllowed, .internationalRoamingOff,
    ]
}
