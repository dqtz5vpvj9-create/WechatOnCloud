import Foundation
import CoreGraphics

func event(_ type: CGEventType, _ x: CGFloat, _ y: CGFloat) {
    guard let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left) else { exit(2) }
    e.post(tap: .cghidEventTap)
}
event(.mouseMoved, 280, 300)
usleep(200_000)
event(.leftMouseDown, 280, 300)
usleep(350_000)
for i in 1...100 {
    event(.leftMouseDragged, 280 + CGFloat(i) * 5.0, 300)
    usleep(35_000)
}
usleep(500_000)
event(.leftMouseUp, 780, 300)

