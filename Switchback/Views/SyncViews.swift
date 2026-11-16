import SwiftUI

/// Settings › Account & sync. Signing in is optional: without it everything stays on this phone.
struct ServerSyncSection: View {
    @EnvironmentObject private var sync: SyncEngine
    @AppStorage(ServerConfig.enabledKey) private var enabled = true
    @State private var address = UserDefaults.standard.string(forKey: ServerConfig.urlKey) ?? ""
    @State private var key = ""
    @State private var hasKey = ServerConfig.apiKey != nil
    @State private var check: String?
    @State private var checking = false
    @State private var editing = false

    var body: some View {
        Section {
            if ServerConfig.isConfigured && !editing {
                LabeledContent("Server", value: ServerConfig.baseURL?.host ?? "")
                Toggle("Sync", isOn: $enabled)
                    .onChange(of: enabled) { _, _ in sync.configurationChanged() }
                if enabled { status }
                Button {
                    Task { await sync.sync() }
                } label: {
                    HStack {
                        Label("Sync now", systemImage: "arrow.triangle.2.circlepath.icloud")
                        Spacer()
                        if sync.isSyncing { ProgressView() }
                    }
                }
                .disabled(sync.isSyncing || !enabled)
                checkButton
                Button("Change server or key") {
                    address = UserDefaults.standard.string(forKey: ServerConfig.urlKey) ?? ServerConfig.baseURL?.absoluteString ?? ""
                    editing = true
                }
                Button("Sign out", role: .destructive) {
                    UserDefaults.standard.removeObject(forKey: ServerConfig.urlKey)
                    ServerConfig.setAPIKey("")
                    hasKey = ServerConfig.apiKey != nil
                    address = ""
                    sync.configurationChanged()
                }
            } else {
                TextField("Server address", text: $address, prompt: Text("https://your-server.example"))
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField(hasKey ? "API key (saved; type to replace)" : "API key", text: $key)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                checkButton
                Button("Sign in") {
                    if let u = ServerConfig.normalized(address) {
                        UserDefaults.standard.set(u.absoluteString, forKey: ServerConfig.urlKey)
                    }
                    if !key.isEmpty { ServerConfig.setAPIKey(key) }
                    key = ""
                    hasKey = ServerConfig.apiKey != nil
                    editing = false
                    enabled = true
                    sync.configurationChanged()
                }
                .disabled(ServerConfig.normalized(address) == nil || (key.isEmpty && !hasKey))
                if editing {
                    Button("Cancel") { editing = false; key = "" }
                }
            }
            if let check {
                Text(check).font(.footnote).foregroundStyle(.secondary)
            }
        } header: {
            Text("Account & sync")
        } footer: {
            Text(ServerConfig.isConfigured
                 ? "Saved trails and recorded hikes are kept on this phone and synced with your server whenever it can be reached. Changes made offline are sent later."
                 : "You don't need to sign in: without it, your saved trails and hikes stay on this phone. Sign in to back them up to a Switchback server and sync them between devices; what you already have is uploaded the first time.")
        }
    }

    @ViewBuilder
    private var status: some View {
        if let err = sync.lastError {
            Label(err, systemImage: sync.isOffline ? "icloud.slash" : "exclamationmark.icloud")
                .foregroundStyle(sync.isOffline ? Color.secondary : Color.red)
                .font(.footnote)
        } else if let d = sync.lastSync {
            LabeledContent("Last synced", value: d.formatted(.relative(presentation: .named)))
        } else {
            LabeledContent("Last synced", value: "Not yet")
        }
        if sync.pendingCount > 0 {
            LabeledContent("Waiting to upload", value: "\(sync.pendingCount)")
        }
    }

    private var checkButton: some View {
        Button {
            let typed = ServerConfig.normalized(address) ?? ServerConfig.baseURL
            guard let u = typed else {
                check = "Enter the server address first (https only)."
                return
            }
            checking = true
            Task {
                check = await SyncEngine.checkConnection(u)
                checking = false
            }
        } label: {
            HStack {
                Label("Check connection", systemImage: "antenna.radiowaves.left.and.right")
                Spacer()
                if checking { ProgressView() }
            }
        }
        .disabled(checking)
    }
}

/// A small cloud in the toolbar while syncing or when sync has a problem; tap it to see what's wrong.
struct SyncStatusButton: View {
    @EnvironmentObject private var sync: SyncEngine
    @State private var show = false

    var body: some View {
        if sync.isActive {
            if sync.isSyncing {
                ProgressView().controlSize(.small)
            } else if let err = sync.lastError {
                Button { show = true } label: {
                    Image(systemName: sync.isOffline ? "icloud.slash" : "exclamationmark.icloud")
                        .foregroundStyle(sync.isOffline ? Color.secondary : Color.red)
                }
                .accessibilityLabel("Sync problem")
                .alert(sync.isOffline ? "Offline" : "Sync problem", isPresented: $show) {
                    Button("Try again") { Task { await sync.sync() } }
                    Button("OK", role: .cancel) {}
                } message: {
                    Text(err)
                }
            }
        }
    }
}
