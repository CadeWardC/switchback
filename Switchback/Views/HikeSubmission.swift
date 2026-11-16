import SwiftUI

/// What everyone is told before they send anything in.
enum PublicUse {
    static let notice = "By submitting, you agree that your hike, the points you marked and your review may be shown publicly in Switchback, and that any photos you submit are for public use: anyone may see, share and reuse them. Submissions are checked before they're added to the trail data."
}

/// Asks whether to send a recorded hike (with the points marked on it) in for review. The hike needs a proper
/// name; nothing is added to the trail data until it has been checked and approved.
struct SubmitHikeView: View {
    let activity: Activity
    @EnvironmentObject private var library: Library
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var rating = 0
    @State private var review = ""
    @State private var agreed = false
    @State private var sending = false
    @State private var error: String?

    /// The names the recorder makes up; a submitted hike needs a real one.
    static let placeholderNames: Set<String> = ["morning hike", "afternoon hike", "evening hike", "night hike"]

    init(activity: Activity) {
        self.activity = activity
        let n = activity.name
        _name = State(initialValue: Self.placeholderNames.contains(n.lowercased()) ? "" : n)
    }

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var nameOK: Bool { trimmedName.count >= 3 && !Self.placeholderNames.contains(trimmedName.lowercased()) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Trail name", text: $name)
                } header: {
                    Text("Name")
                } footer: {
                    Text(nameOK ? "Hiked \(Fmt.distance(activity.distance)), ↑ \(Fmt.elevation(activity.gain))."
                                : "A submitted hike needs the trail's name.")
                }

                Section("Points you marked") {
                    let pts = activity.points ?? []
                    if pts.isEmpty {
                        Text("None. While recording, tap Mark point to add water, viewpoints, hazards and more.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(pts) { p in
                        Label {
                            VStack(alignment: .leading) {
                                Text(p.kind.title)
                                if !p.note.isEmpty { Text(p.note).font(.caption).foregroundStyle(.secondary) }
                            }
                        } icon: { Image(systemName: p.kind.symbol) }
                    }
                }

                Section("Review (optional)") {
                    HStack {
                        ForEach(1...5, id: \.self) { i in
                            Button { rating = rating == i ? 0 : i } label: {
                                Image(systemName: i <= rating ? "star.fill" : "star")
                                    .foregroundStyle(.yellow)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("\(i) star\(i == 1 ? "" : "s")")
                        }
                    }
                    TextField("How was it?", text: $review, axis: .vertical)
                        .lineLimit(3...8)
                }

                Section {
                    Toggle("I agree", isOn: $agreed)
                } footer: {
                    Text(PublicUse.notice)
                }

                if !ServerConfig.isConfigured {
                    Section {
                        Text("Sign in under Settings › Account & sync to submit hikes. Your hike is already saved on this phone.")
                            .foregroundStyle(.secondary)
                    }
                }

                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Submit this hike?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Not now") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if sending {
                        ProgressView()
                    } else {
                        Button("Submit") { Task { await send() } }
                            .disabled(!nameOK || !agreed || !ServerConfig.isConfigured)
                    }
                }
            }
        }
    }

    private func send() async {
        sending = true
        error = nil
        defer { sending = false }
        let text = review.trimmingCharacters(in: .whitespacesAndNewlines)
        let r = rating > 0 || !text.isEmpty ? SubmissionDoc.Review(rating: rating > 0 ? rating : nil, text: text) : nil
        do {
            if activity.name != trimmedName { library.renameActivity(id: activity.id, to: trimmedName) }
            let id = try await SyncEngine.shared.submit(activity, name: trimmedName, review: r)
            library.markSubmitted(id: activity.id, submissionId: id)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Marks a point where you are, while recording.
struct MarkPointView: View {
    @EnvironmentObject private var recorder: Recorder
    @Environment(\.dismiss) private var dismiss
    @State private var kind: HikePoint.Kind = .water
    @State private var note = ""
    @State private var noFix = false

    var body: some View {
        NavigationStack {
            Form {
                Picker("What's here", selection: $kind) {
                    ForEach(HikePoint.Kind.allCases) { k in
                        Label(k.title, systemImage: k.symbol).tag(k)
                    }
                }
                .pickerStyle(.inline)
                TextField("Note (optional)", text: $note, axis: .vertical)
                if noFix {
                    Text("No GPS position yet. Wait a moment and try again.").foregroundStyle(.red)
                }
                if !recorder.points.isEmpty {
                    Section("Marked on this hike") {
                        ForEach(recorder.points) { p in
                            Label(p.note.isEmpty ? p.kind.title : "\(p.kind.title): \(p.note)", systemImage: p.kind.symbol)
                        }
                        .onDelete { idx in idx.map { recorder.points[$0].id }.forEach(recorder.removePoint) }
                    }
                }
            }
            .navigationTitle("Mark a point")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Mark here") {
                        if recorder.mark(kind, note: note) { dismiss() } else { noFix = true }
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

/// On a hike's page: where its submission stands, or a button to submit it.
struct SubmissionStatusRow: View {
    let activity: Activity
    @State private var status: String?
    @State private var submitting = false

    var body: some View {
        Group {
            if let id = activity.submissionId {
                Label(label(status), systemImage: status == "approved" ? "checkmark.seal.fill" : status == "rejected" ? "xmark.seal" : "clock")
                    .font(.subheadline)
                    .foregroundStyle(status == "approved" ? Color.trailGreen : .secondary)
                    .task(id: id) { status = await SyncEngine.shared.submissionStatus(id) }
            } else {
                Button { submitting = true } label: {
                    Label("Submit for review", systemImage: "paperplane").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
            }
        }
        .sheet(isPresented: $submitting) { SubmitHikeView(activity: activity) }
    }

    private func label(_ s: String?) -> String {
        switch s {
        case "approved": return "Submitted: approved and added to the trail data"
        case "rejected": return "Submitted: not added after review"
        case .some: return "Submitted: waiting for review"
        case nil: return "Submitted for review"
        }
    }
}
