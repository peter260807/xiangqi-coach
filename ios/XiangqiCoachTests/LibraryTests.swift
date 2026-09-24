import XCTest
@testable import XiangqiCoach

/// 棋谱库校验。
///
/// 库里的局面全是手工编排或从公开题库导入的，最容易出的问题不是「引擎算不出杀」，
/// 而是「局面本身摆错了」—— 比如黑方开局就已经无子可动（等于随便走一步就赢），
/// 或者压根没在将军却被当成杀局。这类错误光看棋谱看不出来，必须逐条走一遍。
final class LibraryTests: XCTestCase {

    private let lib = XiangqiLibrary.loadFromBundle()

    override func setUp() {
        super.setUp()
        Engine.shared.resetForTesting()
    }

    func testLibraryIsBundledAndNonEmpty() {
        XCTAssertFalse(lib.mates.isEmpty, "library.json 没打进 App bundle，检查 ios/XiangqiCoach/Resources/")
        XCTAssertFalse(lib.openings.isEmpty, "开局库为空")
        XCTAssertFalse(lib.studies.isEmpty, "残局库为空")
        XCTAssertEqual(lib.version, 1)
    }

    /// bundle 里必须是**同步过**的题库，不能停在导入公考题库之前那份 11 道的旧副本。
    ///
    /// 起因：`ios/XiangqiCoach/Resources/library.json` 是**独立副本**，
    /// `tools/sync-library.js` 只生成网页端那份 `web/js/library-data.js`、不碰它。
    /// 于是导入 445 道 + 用 Pikafish 又解出 525 道（共 981 道）之后，
    /// 网页端有 981 道、iOS 端还是 11 道，而**所有单测照样全绿** ——
    /// 因为它们统统只在 bundle 上断言「非空」。
    func testBundleIsNotTheStaleCopy() {
        XCTAssertGreaterThanOrEqual(
            lib.mates.count, 900,
            "bundle 里的杀法库只有 \(lib.mates.count) 道 —— 大概率还是导入之前的旧副本。"
            + "同步办法：cp shared/library.json ios/XiangqiCoach/Resources/library.json")

        // 抽查三个阶段进来的条目各一个：手写的 / 自研引擎求解的 / Pikafish 求解的
        let ids = Set(lib.mates.map { $0.id })
        for id in ["m1", "x0010", "x0446", "x0970"] where !ids.contains(id) {
            XCTFail("bundle 里缺 \(id) —— 旧副本里不会有的条目")
        }

        XCTAssertGreaterThanOrEqual(
            lib.mates.compactMap { $0.mateIn }.max() ?? 0, 20,
            "最深一题不到 20 手 —— 深杀（Pikafish 求解那批）没进 bundle")
    }

    /// 每道杀法题：① 局面不能是退化的；② **库里的那条解法路线必须真的把对方将死**。
    ///
    /// 判据与网页端 `XQLIB.validateLibrary` 完全一致（那是唯一的数据源口径）：
    ///   ① 红方有子可动、黑方有子可动、黑方开局没被将军、红方一上来没被将、没摆白脸将；
    ///   ② 沿存下来的解法路线逐步走，每一步都能识别且合法；
    ///   ③ 走完最后一步轮到黑方、且黑方无子可动 —— 这才是红方成杀；
    ///   ④ 线路长度 === 2·mateIn − 1。
    ///
    /// ⚠️ 这里**不能**用「引擎搜不搜得到杀棋分」当判据。
    /// 这条断言原来就是那么写的（depth 6），它其实**只对 mateIn ≤ 2 成立** ——
    /// 一直只是靠「bundle 里恰好只有 11 道浅题」才绿的。实测：
    ///   · 把完整库（981 道）塞进 bundle → 大面积失败，
    ///     典型一条是「第 260 局 金创满身：引擎在 6 层内没找到成杀（实际评估 183）」；
    ///   · 用编出来的 Swift 引擎逐题量：mateIn ≤ 2 通过 32/32；
    ///     mateIn = 3 通过 59/61；**mateIn ≥ 4 全部 0/113**（4 手杀要 7 层才看得到）。
    /// 更要紧的是判据本身选错了：搜索验证的是「引擎能不能看到杀」，
    /// 而我们要保证的是「**库里存的那条路线是对的**」—— 那才是给学生看的东西。
    /// 引擎断言只留给浅题（见下面 `testShallowMatePuzzlesAreFoundByEngine`），
    /// 那里它才有意义。
    func testEveryMatePuzzleIsPlayableAndActuallyWins() {
        XCTAssertFalse(lib.mates.isEmpty)
        for m in lib.mates {
            let b = Rules.parse(m.fen)
            XCTAssertEqual(b.count, 90, "\(m.name)：FEN 解析出的盘面长度不对")

            // ① 局面本身不能是退化局面
            XCTAssertGreaterThan(Rules.legalMoves(b, .red).count, 0, "\(m.name)：红方无子可动")
            XCTAssertTrue(Rules.hasLegalMove(b, .black),
                          "\(m.name)：黑方开局就无子可动 —— 这是退化局面，随便走一步就赢")
            XCTAssertFalse(Rules.inCheck(b, .black), "\(m.name)：黑方开局不应已被将军")
            XCTAssertFalse(Rules.inCheck(b, .red), "\(m.name)：红方一上来就处于被将状态")
            XCTAssertFalse(Rules.kingsFacing(b), "\(m.name)：摆出了白脸将")

            // ②③④ 沿存下来的解法路线走一遍
            guard let line = m.line, !line.isEmpty else {
                XCTFail("\(m.name)：没有解法路线 —— 导入题库的题都必须带 line，"
                        + "否则「看解法」是空的、也没法证明它确实能成杀")
                continue
            }
            var bb = Rules.parse(m.fen)
            var side: Side = .red
            var failure: String?
            for (i, token) in line.enumerated() {
                guard let mv = Notation.findMove(board: bb, side: side, text: token) else {
                    failure = "第 \(i + 1) 着「\(token)」在本局面无法识别或不合法"; break
                }
                _ = Rules.makeMove(&bb, mv)
                side = side.other
            }
            if let failure {
                XCTFail("\(m.name)：\(failure)")
                continue
            }
            XCTAssertFalse(Rules.hasLegalMove(bb, side),
                           "\(m.name)：走完解法路线对方仍有子可动 —— 这条路线没有将死")
            XCTAssertEqual(side, .black,
                           "\(m.name)：走完解法路线轮到红方 —— 线路长度是偶数，红方没走最后一步")
            if let n = m.mateIn {
                XCTAssertEqual(line.count, 2 * n - 1,
                               "\(m.name)：线路 \(line.count) 步与标注的 \(n) 手杀对不上")
            }
        }
    }

    /// 浅题（mateIn ≤ 2，共 32 道）另外还要过**引擎**：它得在 6 层内看得到杀棋分。
    ///
    /// 上面那条规则层判据证明的是「存下来的路线对」，证明不了「引擎自己找得到」；
    /// 而 App 的「提示」按钮走的就是引擎。浅题上这条必须成立，深题上它必然不成立
    /// （见 `testEveryMatePuzzleIsPlayableAndActuallyWins` 的注释），所以分开写。
    func testShallowMatePuzzlesAreFoundByEngine() {
        let shallow = lib.mates.filter { ($0.mateIn ?? 99) <= 2 }
        XCTAssertGreaterThanOrEqual(shallow.count, 20, "浅题太少，这条断言覆盖不到什么")
        for m in shallow {
            let b = Rules.parse(m.fen)
            let r = Engine.shared.searchSync(board: b, side: .red, maxDepth: 6, timeMs: 8000)
            XCTAssertGreaterThan(r.score, Engine.mate - 1000,
                                 "\(m.name)：引擎在 6 层内没找到成杀（实际评估 \(r.score)）")
            if let mv = r.move {
                XCTAssertTrue(Rules.isLegal(b, .red, mv), "\(m.name)：引擎返回的着法本身不合法")
                var probe = b
                _ = Rules.makeMove(&probe, mv)
                XCTAssertFalse(Rules.hasLegalMove(probe, .black) && !Rules.inCheck(probe, .black),
                               "\(m.name)：推荐的着法把黑方逼成困毙而非将死，题目描述需修正")
            }
        }
    }

    /// 手写的那 11 道杀局应当真的有一个「最优解」，而不是所有着法都一样好 ——
    /// 否则练习页给提示时就失去了意义。
    ///
    /// ⚠️ 只对**手写库**（`set == nil`）断言。导入的几百道题最深到 30 手，
    /// depth 5 的搜索对它们没有分辨力（引擎自己都看不到杀，分数是噪声），
    /// 拿这个判据去量只会得到假失败；而且 981 道 × 每道一次搜索也跑不完。
    func testHandwrittenMatePuzzlesHaveADistinctBestMove() {
        let curated = lib.mates.filter { $0.set == nil }
        XCTAssertFalse(curated.isEmpty, "手写杀法库不该是空的")
        for m in curated {
            let b = Rules.parse(m.fen)
            let cands = Engine.shared.topMovesSync(board: b, side: .red, count: 2, maxDepth: 5, timeMs: 3000)
            guard cands.count >= 2 else { continue }
            XCTAssertGreaterThan(cands[0].score, cands[1].score,
                                 "\(m.name)：前两个候选着法评估相同，题目没有区分度")
        }
    }

    func testEveryOpeningLineIsLegalMoveByMove() {
        XCTAssertFalse(lib.openings.isEmpty)
        for o in lib.openings {
            var b = Rules.parse(Rules.startFEN)
            var side: Side = .red
            var ply = 0
            for token in o.line.split(separator: " ").map(String.init) {
                ply += 1
                guard let m = Notation.findMove(board: b, side: side, text: token) else {
                    XCTFail("\(o.name)：第 \(ply) 手「\(token)」在盘面上不合法")
                    break
                }
                _ = Rules.makeMove(&b, m)
                side = side.other
            }
            XCTAssertGreaterThanOrEqual(ply, 4, "\(o.name)：开局谱太短，起不到演示作用")
            XCTAssertFalse(Rules.inCheck(b, .red), "\(o.name)：走完开局谱后红方被将")
            XCTAssertFalse(Rules.inCheck(b, .black), "\(o.name)：走完开局谱后黑方被将")
        }
    }

    func testEveryStudyPositionIsWellFormed() {
        XCTAssertFalse(lib.studies.isEmpty)
        for s in lib.studies {
            let b = Rules.parse(s.fen)
            XCTAssertGreaterThan(Rules.legalMoves(b, .red).count, 0, "\(s.name)：红方无子可动")
            XCTAssertTrue(Rules.hasLegalMove(b, .black), "\(s.name)：黑方无子可动")
            XCTAssertFalse(Rules.inCheck(b, .red), "\(s.name)：红方一上来就处于被将状态")
            XCTAssertFalse(Rules.kingsFacing(b), "\(s.name)：摆出了白脸将")
            XCTAssertLessThan(Rules.material(b), 60, "\(s.name)：名为残局，子力却还很多")
        }
    }

    /// 难度文案必须说得出**手数**，不能一律「多步杀」。
    ///
    /// 起因：`difficultyText` 原来是一个写死到「十」的数组 `cn[mateIn - 1]`，
    /// 11 手以上全部掉进 tier 兜底、显示「多步杀」。用 Pikafish 求解深杀之后
    /// 库里有 30 手杀，这个洞就露出来了（网页端 `XQSTORE.tierText` 同一处、同时修的）。
    func testDifficultyTextReportsMoveCount() {
        func text(_ mateIn: Int?) -> String {
            MatePuzzle(id: "t", name: "n", tier: 3, fen: Rules.startFEN,
                       idea: nil, set: "s", line: nil, mateIn: mateIn).difficultyText
        }
        XCTAssertEqual(text(1), "一步杀")
        // ⚠️ 2 手刻意是「二」不是「两」：既有文案与网页端筛选徽标都用「二」
        XCTAssertEqual(text(2), "二步杀")
        XCTAssertEqual(text(10), "十步杀")
        XCTAssertEqual(text(11), "十一步杀", "11 手原来会退化成「多步杀」")
        XCTAssertEqual(text(20), "二十步杀", "整十不加个位")
        XCTAssertEqual(text(28), "二十八步杀")
        XCTAssertEqual(text(30), "三十步杀")

        // 边界与退化
        XCTAssertNil(MatePuzzle.cnNum(0), "0 手没有中文写法")
        XCTAssertNil(MatePuzzle.cnNum(100), "超过 99 手不编造（当前库里最深 30 手）")
        XCTAssertEqual(text(nil), "多步杀", "没有 mateIn 的老条目退回 tier 文案，不能变空串")

        // 与真实库里最深的一题对一遍，确认这不是空转
        if let deepest = lib.mates.max(by: { ($0.mateIn ?? 0) < ($1.mateIn ?? 0) }),
           let n = deepest.mateIn {
            XCTAssertNotEqual(deepest.difficultyText, "多步杀",
                              "库里最深一题「\(deepest.name)」（\(n) 手）应当报出手数")
        }
    }

    func testSceneCatalogCoversWholeLibrary() {
        let scenes = SceneCatalog.all(lib)
        XCTAssertEqual(scenes.count,
                       1 + lib.allClassics.count + lib.mates.count + lib.openings.count + lib.studies.count)
        XCTAssertEqual(scenes.first?.id, "start")
        for s in scenes {
            let resolved = SceneCatalog.resolve(s)
            XCTAssertEqual(resolved.board.count, 90)
            // 开局库预摆的着法必须全部落地，否则场景显示的局面与描述不符
            if s.kind == .opening {
                XCTAssertEqual(resolved.moves.count, s.preloadLabels.count,
                               "\(s.title)：有 \(s.preloadLabels.count - resolved.moves.count) 手开局谱没能摆上去")
            }
        }
    }

    /// 导入的题没有手写讲解（`idea`），提示里不能露出 "nil" 或空行 ——
    /// 得用来源名（`set`）兜底。这条在网页端早就处理过，iOS 端一起验。
    func testImportedPuzzlesHaveUsableHintText() {
        let imported = lib.mates.filter { $0.set != nil }
        XCTAssertFalse(imported.isEmpty, "没有导入的题 —— bundle 可能还是旧副本")
        for s in SceneCatalog.all(lib) where s.id.hasPrefix("mate:") {
            XCTAssertFalse(s.note.isEmpty, "\(s.title)：提示文案为空")
            XCTAssertFalse(s.note.contains("nil"), "\(s.title)：提示文案里露出了 nil")
        }
    }
}
