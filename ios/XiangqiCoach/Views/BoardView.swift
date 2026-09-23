import SwiftUI

/// 配色。整体是「暖纸底 + 木质棋盘」的棋院感。
enum Palette {
    static let paper = Color(red: 0.957, green: 0.945, blue: 0.918)
    static let paperDeep = Color(red: 0.922, green: 0.902, blue: 0.859)
    static let card = Color.white
    static let ink = Color(red: 0.129, green: 0.114, blue: 0.094)
    static let ink2 = Color(red: 0.361, green: 0.333, blue: 0.294)
    static let ink3 = Color(red: 0.576, green: 0.545, blue: 0.494)
    static let red = Color(red: 0.706, green: 0.153, blue: 0.114)
    static let redSoft = Color(red: 0.992, green: 0.941, blue: 0.933)
    static let black = Color(red: 0.173, green: 0.165, blue: 0.153)
    static let jade = Color(red: 0.059, green: 0.431, blue: 0.337)
    static let jadeSoft = Color(red: 0.902, green: 0.957, blue: 0.937)
    static let amber = Color(red: 0.604, green: 0.416, blue: 0.071)
    static let accent = Color(red: 0.122, green: 0.435, blue: 0.922)
    static let line = Color.black.opacity(0.10)
    static let lineSoft = Color.black.opacity(0.05)
}

/// 棋盘几何
enum BoardMetrics {
    static let cell: CGFloat = 44
    static let margin: CGFloat = 34
    static let logicalW: CGFloat = 8 * cell + 2 * margin   // 420
    static let logicalH: CGFloat = 9 * cell + 2 * margin   // 464
    static func x(_ c: Int) -> CGFloat { margin + CGFloat(c) * cell }
    static func y(_ r: Int) -> CGFloat { margin + CGFloat(r) * cell }
    static var aspect: CGFloat { logicalW / logicalH }
}

struct BoardView: View {
    @ObservedObject var game: GameState

    var body: some View {
        // 直接让 Canvas 按可用空间取比例缩放。
        // 原来套了一层 GeometryReader —— 它一定会填满给它的全部空间，
        // 于是棋盘按宽度缩放后，下方留出一大片空白，把状态栏顶到屏幕最底部。
        // Canvas 的闭包本身就能拿到可用尺寸，不需要 GeometryReader。
        Canvas { ctx, size in
            let scale = size.width / BoardMetrics.logicalW
            ctx.scaleBy(x: scale, y: scale)
            draw(&ctx)
        }
        .aspectRatio(BoardMetrics.aspect, contentMode: .fit)
    }

    // MARK: - 绘制

    private func draw(_ ctx: inout GraphicsContext) {
        drawWood(&ctx)
        drawGrid(&ctx)
        drawRiver(&ctx)
        drawHighlights(&ctx)

        // 动画中的棋子单独画，避免重复
        var skip = -1
        var animPos: CGPoint?
        if game.animating {
            skip = game.animTo
            let t = min(1, max(0, game.animProgress))
            let e = easeOutCubic(t)
            let p = CGPoint(x: BoardMetrics.x(Rules.col(game.animFrom)),
                            y: BoardMetrics.y(Rules.row(game.animFrom)))
            let q = CGPoint(x: BoardMetrics.x(Rules.col(game.animTo)),
                            y: BoardMetrics.y(Rules.row(game.animTo)))
            animPos = CGPoint(x: p.x + (q.x - p.x) * e, y: p.y + (q.y - p.y) * e)
        }

        for i in 0..<90 {
            let p = game.board[i]
            if p == 0 || i == skip { continue }
            drawPiece(&ctx, p, CGPoint(x: BoardMetrics.x(Rules.col(i)),
                                       y: BoardMetrics.y(Rules.row(i))), scale: 1, alpha: 1)
        }

        // 被吃的子淡出下沉
        if game.animating && game.animCaptured != 0 {
            let t = min(1, max(0, game.animProgress))
            drawPiece(&ctx, game.animCaptured,
                      CGPoint(x: BoardMetrics.x(Rules.col(game.animTo)),
                              y: BoardMetrics.y(Rules.row(game.animTo)) + t * 6),
                      scale: 1 - t * 0.22, alpha: 1 - t)
        }

        if let pos = animPos {
            drawPiece(&ctx, game.animPiece, pos, scale: 1.06, alpha: 1)
        }

        drawCoords(&ctx)
    }

    private func easeOutCubic(_ t: Double) -> Double { 1 - pow(1 - t, 3) }

    private func roundRect(_ r: CGRect, _ radius: CGFloat) -> Path {
        Path(roundedRect: r, cornerRadius: radius)
    }

    private func drawWood(_ ctx: inout GraphicsContext) {
        let full = CGRect(x: 0, y: 0, width: BoardMetrics.logicalW, height: BoardMetrics.logicalH)
        ctx.fill(roundRect(full, 14), with: .linearGradient(
            Gradient(colors: [
                Color(red: 0.953, green: 0.890, blue: 0.765),
                Color(red: 0.929, green: 0.863, blue: 0.722),
                Color(red: 0.890, green: 0.812, blue: 0.651)
            ]),
            startPoint: CGPoint(x: 0, y: 0),
            endPoint: CGPoint(x: BoardMetrics.logicalW * 0.35, y: BoardMetrics.logicalH)))

        // 四角压暗，模拟木料边缘
        ctx.fill(roundRect(full, 14), with: .radialGradient(
            Gradient(colors: [Color.clear, Color(red: 0.588, green: 0.463, blue: 0.282).opacity(0.18)]),
            center: CGPoint(x: BoardMetrics.logicalW / 2, y: BoardMetrics.logicalH / 2),
            startRadius: BoardMetrics.logicalH * 0.25,
            endRadius: BoardMetrics.logicalH * 0.78))
    }

    private func drawGrid(_ ctx: inout GraphicsContext) {
        let m = BoardMetrics.margin
        let lineColor = Color(red: 0.580, green: 0.439, blue: 0.251).opacity(0.62)
        var grid = Path()

        for r in 0..<10 {
            grid.move(to: CGPoint(x: BoardMetrics.x(0), y: BoardMetrics.y(r)))
            grid.addLine(to: CGPoint(x: BoardMetrics.x(8), y: BoardMetrics.y(r)))
        }
        for c in 0..<9 {
            if c == 0 || c == 8 {
                grid.move(to: CGPoint(x: BoardMetrics.x(c), y: BoardMetrics.y(0)))
                grid.addLine(to: CGPoint(x: BoardMetrics.x(c), y: BoardMetrics.y(9)))
            } else {
                grid.move(to: CGPoint(x: BoardMetrics.x(c), y: BoardMetrics.y(0)))
                grid.addLine(to: CGPoint(x: BoardMetrics.x(c), y: BoardMetrics.y(4)))
                grid.move(to: CGPoint(x: BoardMetrics.x(c), y: BoardMetrics.y(5)))
                grid.addLine(to: CGPoint(x: BoardMetrics.x(c), y: BoardMetrics.y(9)))
            }
        }
        // 九宫斜线
        grid.move(to: CGPoint(x: BoardMetrics.x(3), y: BoardMetrics.y(0)))
        grid.addLine(to: CGPoint(x: BoardMetrics.x(5), y: BoardMetrics.y(2)))
        grid.move(to: CGPoint(x: BoardMetrics.x(5), y: BoardMetrics.y(0)))
        grid.addLine(to: CGPoint(x: BoardMetrics.x(3), y: BoardMetrics.y(2)))
        grid.move(to: CGPoint(x: BoardMetrics.x(3), y: BoardMetrics.y(7)))
        grid.addLine(to: CGPoint(x: BoardMetrics.x(5), y: BoardMetrics.y(9)))
        grid.move(to: CGPoint(x: BoardMetrics.x(5), y: BoardMetrics.y(7)))
        grid.addLine(to: CGPoint(x: BoardMetrics.x(3), y: BoardMetrics.y(9)))

        ctx.stroke(grid, with: .color(lineColor), lineWidth: 1)

        // 外框加重
        ctx.stroke(Path(CGRect(x: m, y: m, width: 8 * BoardMetrics.cell, height: 9 * BoardMetrics.cell)),
                   with: .color(Color(red: 0.502, green: 0.373, blue: 0.204).opacity(0.85)),
                   lineWidth: 2)

        // 传统定位点
        let full: [(Int, Int)] = [(-1, -1), (1, -1), (-1, 1), (1, 1)]
        let left: [(Int, Int)] = [(1, -1), (1, 1)]
        let right: [(Int, Int)] = [(-1, -1), (-1, 1)]
        mark(&ctx, 2, 1, full); mark(&ctx, 2, 7, full)
        mark(&ctx, 7, 1, full); mark(&ctx, 7, 7, full)
        mark(&ctx, 3, 0, left); mark(&ctx, 3, 2, full); mark(&ctx, 3, 4, full)
        mark(&ctx, 3, 6, full); mark(&ctx, 3, 8, right)
        mark(&ctx, 6, 0, left); mark(&ctx, 6, 2, full); mark(&ctx, 6, 4, full)
        mark(&ctx, 6, 6, full); mark(&ctx, 6, 8, right)
    }

    private func mark(_ ctx: inout GraphicsContext, _ r: Int, _ c: Int, _ quadrants: [(Int, Int)]) {
        let x = BoardMetrics.x(c), y = BoardMetrics.y(r)
        let d: CGFloat = 5, len: CGFloat = 9
        var p = Path()
        for q in quadrants {
            let sx = x + CGFloat(q.0) * d
            let sy = y + CGFloat(q.1) * d
            p.move(to: CGPoint(x: sx, y: sy + CGFloat(q.1) * len))
            p.addLine(to: CGPoint(x: sx, y: sy))
            p.addLine(to: CGPoint(x: sx + CGFloat(q.0) * len, y: sy))
        }
        ctx.stroke(p, with: .color(Color(red: 0.549, green: 0.416, blue: 0.227).opacity(0.65)), lineWidth: 1)
    }

    private func drawRiver(_ ctx: inout GraphicsContext) {
        var text = Text("楚  河").font(.system(size: 17, weight: .semibold, design: .serif))
        text = text.foregroundColor(Color(red: 0.541, green: 0.408, blue: 0.235).opacity(0.5))
        ctx.draw(text, at: CGPoint(x: BoardMetrics.x(2), y: BoardMetrics.y(4) + BoardMetrics.cell / 2))

        var text2 = Text("汉  界").font(.system(size: 17, weight: .semibold, design: .serif))
        text2 = text2.foregroundColor(Color(red: 0.541, green: 0.408, blue: 0.235).opacity(0.5))
        ctx.draw(text2, at: CGPoint(x: BoardMetrics.x(6), y: BoardMetrics.y(4) + BoardMetrics.cell / 2))
    }

    private func drawPiece(_ ctx: inout GraphicsContext, _ p: Int8, _ center: CGPoint,
                           scale: CGFloat, alpha: Double) {
        guard p != 0 else { return }
        let red = Piece.isRed(p)
        let rad = BoardMetrics.cell * 0.43 * scale
        let ring = red ? Color(red: 0.659, green: 0.157, blue: 0.110)
                       : Color(red: 0.141, green: 0.133, blue: 0.125)

        // 投影
        ctx.opacity = alpha * 0.22
        ctx.fill(Path(ellipseIn: CGRect(x: center.x - rad * 0.95,
                                        y: center.y + rad * 0.42 - rad * 0.34,
                                        width: rad * 1.9, height: rad * 0.68)),
                 with: .color(Color(red: 0.376, green: 0.275, blue: 0.141)))

        ctx.opacity = alpha
        // 棋面
        let face = CGRect(x: center.x - rad, y: center.y - rad, width: rad * 2, height: rad * 2)
        ctx.fill(Path(ellipseIn: face), with: .radialGradient(
            Gradient(colors: [
                Color(red: 1.0, green: 0.992, blue: 0.965),
                Color(red: 0.973, green: 0.925, blue: 0.843),
                Color(red: 0.910, green: 0.839, blue: 0.706)
            ]),
            center: CGPoint(x: center.x - rad * 0.34, y: center.y - rad * 0.42),
            startRadius: rad * 0.12, endRadius: rad * 1.08))

        ctx.stroke(Path(ellipseIn: face), with: .color(ring),
                   lineWidth: max(1.5, rad * 0.09))

        ctx.opacity = alpha * 0.34
        let inner = CGRect(x: center.x - rad * 0.82, y: center.y - rad * 0.82,
                           width: rad * 1.64, height: rad * 1.64)
        ctx.stroke(Path(ellipseIn: inner), with: .color(ring), lineWidth: 1)
        ctx.opacity = alpha

        // 字符
        var text = Text(Piece.name(p))
            .font(.system(size: rad * 1.32, weight: .semibold, design: .serif))
        text = text.foregroundColor(red ? Palette.red : Color(red: 0.149, green: 0.141, blue: 0.133))
        ctx.draw(text, at: CGPoint(x: center.x, y: center.y + rad * 0.04))
    }

    private func ringPath(_ i: Int, inset: CGFloat = 0) -> Path {
        let x = BoardMetrics.x(Rules.col(i)), y = BoardMetrics.y(Rules.row(i))
        let h = BoardMetrics.cell * 0.44 + inset
        let s = h * 0.52
        var p = Path()
        for c in [(-1.0, -1.0), (1.0, -1.0), (-1.0, 1.0), (1.0, 1.0)] {
            let sx = x + CGFloat(c.0) * h, sy = y + CGFloat(c.1) * h
            p.move(to: CGPoint(x: sx, y: sy - CGFloat(c.1) * s))
            p.addLine(to: CGPoint(x: sx, y: sy))
            p.addLine(to: CGPoint(x: sx - CGFloat(c.0) * s, y: sy))
        }
        return p
    }

    private func drawHighlights(_ ctx: inout GraphicsContext) {
        // 上一步落点
        if let lm = game.lastMove {
            let rects = [lm.from, lm.to].map {
                CGRect(x: BoardMetrics.x(Rules.col($0)) - BoardMetrics.cell * 0.42,
                       y: BoardMetrics.y(Rules.row($0)) - BoardMetrics.cell * 0.42,
                       width: BoardMetrics.cell * 0.84, height: BoardMetrics.cell * 0.84)
            }
            for r in rects {
                ctx.fill(roundRect(r, 8), with: .color(Palette.accent.opacity(0.10)))
                ctx.stroke(roundRect(r, 8), with: .color(Palette.accent.opacity(0.28)), lineWidth: 1)
            }
        }

        // 选中 + 可落点
        if game.selected >= 0 {
            ctx.stroke(ringPath(game.selected), with: .color(Palette.accent.opacity(0.95)), lineWidth: 3)
            for m in game.targets {
                let center = CGPoint(x: BoardMetrics.x(Rules.col(m.to)),
                                     y: BoardMetrics.y(Rules.row(m.to)))
                if game.board[m.to] != 0 {
                    ctx.stroke(Path(ellipseIn: CGRect(x: center.x - BoardMetrics.cell * 0.45,
                                                      y: center.y - BoardMetrics.cell * 0.45,
                                                      width: BoardMetrics.cell * 0.9,
                                                      height: BoardMetrics.cell * 0.9)),
                               with: .color(Palette.accent.opacity(0.55)), lineWidth: 3)
                } else {
                    ctx.fill(Path(ellipseIn: CGRect(x: center.x - 5.5, y: center.y - 5.5,
                                                    width: 11, height: 11)),
                             with: .color(Palette.accent.opacity(0.45)))
                }
            }
        }

        // 建议着法箭头
        if let hm = game.hintMove {
            let a = CGPoint(x: BoardMetrics.x(Rules.col(hm.from)), y: BoardMetrics.y(Rules.row(hm.from)))
            let b = CGPoint(x: BoardMetrics.x(Rules.col(hm.to)), y: BoardMetrics.y(Rules.row(hm.to)))
            let ang = atan2(b.y - a.y, b.x - a.x)
            let off = BoardMetrics.cell * 0.36
            var line = Path()
            line.move(to: CGPoint(x: a.x + cos(ang) * off, y: a.y + sin(ang) * off))
            line.addLine(to: CGPoint(x: b.x - cos(ang) * off, y: b.y - sin(ang) * off))
            ctx.stroke(line, with: .color(Palette.accent.opacity(0.95)),
                       style: StrokeStyle(lineWidth: 2.6, lineCap: .round, dash: [6, 5]))
            for p in [a, b] {
                ctx.stroke(Path(ellipseIn: CGRect(x: p.x - BoardMetrics.cell * 0.47,
                                                  y: p.y - BoardMetrics.cell * 0.47,
                                                  width: BoardMetrics.cell * 0.94,
                                                  height: BoardMetrics.cell * 0.94)),
                           with: .color(Palette.accent.opacity(0.95)), lineWidth: 2.6)
            }
        }

        // 将军
        if let side = game.checkSide {
            let ki = Rules.kingIndex(game.board, side)
            if ki >= 0 {
                let c = CGPoint(x: BoardMetrics.x(Rules.col(ki)), y: BoardMetrics.y(Rules.row(ki)))
                ctx.stroke(Path(ellipseIn: CGRect(x: c.x - BoardMetrics.cell * 0.5,
                                                  y: c.y - BoardMetrics.cell * 0.5,
                                                  width: BoardMetrics.cell, height: BoardMetrics.cell)),
                           with: .color(Palette.red.opacity(0.8)), lineWidth: 3.2)
            }
        }
    }

    /// 棋盘上下的方位标注。
    ///
    /// 用象棋的标准记法，不是国际象棋的 a~i / 9~0 —— 后者在棋盘上写着 h3，
    /// 棋谱里却是「炮二平五」，两套编号谁都对不上。
    ///   下边（红方）：纵线自右向左为「一」到「九」
    ///   上边（黑方）：纵线自左向右为「1」到「9」
    /// 例：黑将开局在中间那列（黑方 5 路），「将5平6」就是它往右挪一格。
    /// 横线方向在记法里只有「进/退 + 步数」，本身没有编号，所以左右两侧不标数字。
    ///
    /// 编号规则与 `Notation.fileNumber` 是同一套：红方 9-col，黑方 col+1。
    private func drawCoords(_ ctx: inout GraphicsContext) {
        let redNums = ["一", "二", "三", "四", "五", "六", "七", "八", "九"]
        // 位置要挑在「棋子够不到」的那条留白里：棋子半径 0.43 格，
        // 底线/顶线的棋子从 0.42 格处开始，所以标注只能贴到 0.26 格处，
        // 否则红方的字会压在红方底线的车上，糊成一团。
        let yTop = BoardMetrics.margin * 0.26
        let yBottom = BoardMetrics.logicalH - BoardMetrics.margin * 0.26
        for c in 0..<9 {
            // 红方在下：最右边那列是「一」，往左递增到「九」
            var red = Text(redNums[8 - c])
                .font(.system(size: 10, weight: .medium, design: .serif))
            red = red.foregroundColor(Palette.red.opacity(0.62))
            ctx.draw(red, at: CGPoint(x: BoardMetrics.x(c), y: yBottom))

            // 黑方在上：最左边那列是「1」
            var black = Text(String(c + 1))
                .font(.system(size: 10, weight: .medium, design: .monospaced))
            black = black.foregroundColor(Palette.ink.opacity(0.55))
            ctx.draw(black, at: CGPoint(x: BoardMetrics.x(c), y: yTop))
        }
    }
}
