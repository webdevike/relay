import Foundation
import WebRTC

/// Receives WebRTC's peer connection and data channel callbacks (on its signaling thread) and
/// hands the ones a live call needs to the main actor, in the order they happened.
final class LiveCallPeerObserver: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate, @unchecked Sendable {
  // Set once, before the peer connection exists.
  var onGatheringComplete: (@MainActor () -> Void)?
  var onPeerState: (@MainActor (RTCPeerConnectionState) -> Void)?
  var onChannelState: (@MainActor (RTCDataChannelState) -> Void)?
  var onMessage: (@MainActor (Data) -> Void)?

  private func onMain(_ body: @escaping @MainActor () -> Void) {
    DispatchQueue.main.async {
      MainActor.assumeIsolated(body)
    }
  }

  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
    guard newState == .complete, let handler = onGatheringComplete else { return }
    onMain { handler() }
  }

  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
    guard let handler = onPeerState else { return }
    onMain { handler(newState) }
  }

  func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
    guard let handler = onChannelState else { return }
    let state = dataChannel.readyState
    onMain { handler(state) }
  }

  func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
    guard let handler = onMessage else { return }
    let data = buffer.data
    onMain { handler(data) }
  }

  // Not needed: one audio transceiver and one data channel, both made before the offer; non-trickle ICE.
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
  func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
