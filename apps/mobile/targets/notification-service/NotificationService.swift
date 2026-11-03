// An assistant reply arrives as a Communication Notification: the host marks it `mutableContent`
// with Expo data `{ assistant: true, agent: "<id>" }` (under `userInfo["body"]`) and the title set
// to the assistant's name. This donates an incoming INSendMessageIntent from that assistant, with
// its portrait (avatar-<id>.png, bundled in this extension), and hands iOS the content updated from
// the intent, so the banner shows the portrait with a small Relay badge, like a message in
// Messages. Anything else, or a failure, is delivered unchanged.

import Intents
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
  private var deliver: ((UNNotificationContent) -> Void)?
  private var original: UNNotificationContent?

  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    deliver = contentHandler
    original = request.content
    guard let sender = AssistantSender(request.content) else {
      finish(request.content)
      return
    }
    let intent = sender.intent(body: request.content.body)
    let interaction = INInteraction(intent: intent, response: nil)
    interaction.direction = .incoming
    interaction.donate { [weak self] _ in
      // A failed donation still leaves the content updatable; iOS just learns less about the sender.
      let updated = (try? request.content.updating(from: intent)) ?? request.content
      self?.finish(updated)
    }
  }

  override func serviceExtensionTimeWillExpire() {
    if let original { finish(original) }
  }

  private func finish(_ content: UNNotificationContent) {
    guard let deliver else { return }
    self.deliver = nil
    deliver(content)
  }
}

/// The assistant a push is from, read from the push's Expo data.
private struct AssistantSender {
  let id: String
  let name: String

  init?(_ content: UNNotificationContent) {
    guard let data = content.userInfo["body"] as? [String: Any],
      data["assistant"] as? Bool == true,
      let id = data["agent"] as? String,
      id.range(of: "^[a-z0-9][a-z0-9-]{0,63}$", options: .regularExpression) != nil
    else { return nil }
    self.id = id
    let title = content.title.trimmingCharacters(in: .whitespacesAndNewlines)
    name = title.isEmpty ? id.prefix(1).uppercased() + id.dropFirst() : title
  }

  /// One-to-one: no recipients, the conversation is the assistant's thread.
  func intent(body: String) -> INSendMessageIntent {
    let image = avatar()
    let person = INPerson(
      personHandle: INPersonHandle(value: "assistant:\(id)", type: .unknown),
      nameComponents: nil,
      displayName: name,
      image: image,
      contactIdentifier: nil,
      customIdentifier: "assistant:\(id)"
    )
    let intent = INSendMessageIntent(
      recipients: nil,
      outgoingMessageType: .outgoingMessageText,
      content: body,
      speakableGroupName: nil,
      conversationIdentifier: "assistant:\(id)",
      serviceName: nil,
      sender: person,
      attachments: nil
    )
    if let image { intent.setImage(image, forParameterNamed: \.sender) }
    return intent
  }

  /// The bundled portrait; none for an assistant this build does not know (iOS shows initials).
  private func avatar() -> INImage? {
    guard let url = Bundle.main.url(forResource: "avatar-\(id)", withExtension: "png"), let data = try? Data(contentsOf: url) else { return nil }
    return INImage(imageData: data)
  }
}
