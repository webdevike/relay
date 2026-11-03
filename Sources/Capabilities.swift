import Foundation

/// "What can you do here?" and "help": what the assistant can really do in the app in front, from what
/// is wired for it (an app hook, Jev navigation, the shortcuts, lessons, handoffs), with two things to
/// try. A template, so no model call: it answers at once and never claims something that isn't there.
enum Capabilities {
    struct Answer: Equatable {
        /// A few spoken sentences.
        let spoken: String
        /// One caption line (at most about 90 characters).
        let caption: String
    }

    private static let pattern = try! NSRegularExpression(pattern: #"^\s*(?:so\s+|ok\s+|okay\s+|hey\s+)?(?:"# + [
        #"help(?:\s+me)?"#,
        #"what\s+(?:can|could)\s+you\s+(?:do|help(?:\s+me)?\s+with)(?:\s+(?:here|in\s+(?:here|this(?:\s+app)?)|for\s+me(?:\s+here)?))?"#,
        #"what\s+do\s+you\s+do(?:\s+here)?"#,
        #"how\s+can\s+you\s+help(?:\s+me)?(?:\s+here)?"#,
    ].joined(separator: "|") + #")[\s?.!]*$"#, options: .caseInsensitive)

    static func isAsking(_ question: String) -> Bool {
        pattern.firstMatch(in: question, range: NSRange(question.startIndex..., in: question)) != nil
    }

    /// `hook`: the app hook's name ("Blender", "Linear") or nil; `navigates`: Jev can walk this app's
    /// screens; `inLesson`: a lesson is running; `workAssistant`: who gets tickets (Astra).
    static func answer(app: String, bundleID: String, hook: String?, navigates: Bool, inLesson: Bool,
                       workAssistant: String) -> Answer {
        let spoken: String
        let caption: String
        switch hook {
        case "Blender":
            spoken = "In Blender I can point you at any tool, teach you step by step, and switch modes for you. " +
                "Try \"where's the bevel tool\" or \"teach me to add a torus\"."
            caption = "Find tools, lessons that check off, mode chores. Try \"where's the bevel tool\""
        case "Linear":
            spoken = "Here I can explain this ticket and what's blocking it, open any issue by its key, " +
                "and hand it to \(workAssistant). I only read Linear. Try \"what's blocking this?\""
            caption = "Explain tickets, open by key, hand off, remind. Try \"what's blocking this?\""
        default:
            let (first, second) = examples(bundleID: bundleID, navigates: navigates)
            let moves = navigates ? "point at anything, take you to the right screen, and do small chores"
                : "point at anything and do small chores"
            spoken = "In \(app) I can \(moves). I can also open tickets and hand things off. " +
                "Try \"\(first)\" or \"\(second)\"."
            caption = (navigates ? "Point, navigate, chores, open tickets, hand off." : "Point, chores, open tickets, hand off.") +
                " Try \"\(first)\""
        }
        guard inLesson else { return Answer(spoken: spoken, caption: caption) }
        return Answer(spoken: "You're in a lesson right now: say next, skip or stop. " + spoken,
                      caption: "In a lesson: next, skip or stop. " + caption)
    }

    /// Two things to say in this app; the second is a navigation ask only where Jev can navigate.
    private static func examples(bundleID: String, navigates: Bool) -> (String, String) {
        let known: [String: (String, String)] = [
            "com.apple.finder": ("how do I make a new folder", "take me to Downloads"),
            "com.apple.systempreferences": ("where's Wi-Fi", "take me to Bluetooth"),
            "com.apple.Safari": ("where are my bookmarks", "take me to Settings"),
            "com.google.Chrome": ("where are my bookmarks", "take me to Settings"),
            "company.thebrowser.Browser": ("where are my bookmarks", "take me to Settings"),
            "com.tinyspeck.slackmacgap": ("where are my saved items", "take me to my DMs"),
        ]
        let (first, second) = known[bundleID] ?? ("what's this window for?", "take me to Settings")
        return (first, navigates ? second : "remind me about this tomorrow")
    }
}
