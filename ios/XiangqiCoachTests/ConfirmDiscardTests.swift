import XCTest
@testable import XiangqiCoach

/// 「会把当前这盘棋丢掉」的操作，都必须先问一句。
///
/// 这条规则是被误触逼出来的：「重开」按钮就挨着「悔棋」；场景菜单里换一局、
/// 训练页点开一个练习、战绩页载入存档，同样会把这盘棋清掉。
/// 用测试把这几条入口钉住 —— 以后再加一条入口时漏了确认，这里会红。
@MainActor
final class ConfirmDiscardTests: XCTestCase {

    private func makeGame() -> GameState {
        GameState(library: XiangqiLibrary.loadFromBundle())
    }

    /// 目标场景用「导入的局面」（kind = .custom）：它不带预置着法，
    /// 也不会像杀法/残局那样去碰 Archive 这个落盘的全局单例 ——
    /// 单元测试不该顺手往用户存档里写东西。
    private func targetScene() -> XQScene {
        XQScene.custom(title: "测试局面", fen: Rules.startFEN, note: "")
    }

    /// 摆出「已经走过几手」的状态。
    ///
    /// 这里只关心「有棋可丢」这个条件，所以直接往 history 里放条目，
    /// 而不是走 `play(move:)` —— 那会连带启动落子动画和电脑走子的异步流程，
    /// 把异步拖进单元测试只会让它变得不稳定（而且是另一个测试对象）。
    private func pretendMovesPlayed(_ game: GameState, _ count: Int) {
        for i in 0..<count {
            game.history.append(HistoryItem(move: Move(from: i, to: i + 1),
                                            captured: 0, label: "测试\(i)", side: .red))
        }
    }

    // MARK: - 重开

    func testRestartOnFreshBoardDoesNotAsk() {
        let game = makeGame()
        game.requestRestart()
        XCTAssertNil(game.pendingConfirm, "空盘重开等于什么都没发生，不该弹框打扰")
    }

    func testRestartAsksAndSaysHowManyMovesAreLost() {
        let game = makeGame()
        pretendMovesPlayed(game, 5)

        game.requestRestart()

        guard case let .restart(moves, title)? = game.pendingConfirm else {
            return XCTFail("有棋可丢时必须先确认，实际的 pendingConfirm = \(String(describing: game.pendingConfirm))")
        }
        XCTAssertEqual(moves, 5)
        XCTAssertEqual(title, game.scene.title)
        XCTAssertTrue(game.pendingConfirm!.message.contains("5 手"),
                      "提示里要写清会丢掉几手，不能只说「确定吗」")
        XCTAssertEqual(game.pendingConfirm!.confirmLabel, "重开")
    }

    func testConfirmRestartClearsHistoryAndRestoresStartPosition() {
        let game = makeGame()
        pretendMovesPlayed(game, 2)
        game.requestRestart()

        game.confirmPending()

        XCTAssertNil(game.pendingConfirm, "确认后状态要清掉，否则下次弹不出来")
        XCTAssertTrue(game.history.isEmpty)
        XCTAssertEqual(game.board, Rules.parse(game.scene.startFEN))
    }

    func testCancelRestartKeepsTheGame() {
        let game = makeGame()
        pretendMovesPlayed(game, 3)
        game.requestRestart()

        // 点「取消」：视图那层只是把 pendingConfirm 清空，模型什么都不做
        game.pendingConfirm = nil

        XCTAssertEqual(game.history.count, 3, "取消之后这盘棋必须原样还在")
    }

    // MARK: - 换场景

    func testSceneSwitchOnFreshBoardIsImmediate() {
        let game = makeGame()
        let target = targetScene()

        game.requestScene(target)

        XCTAssertNil(game.pendingConfirm, "空盘换场景不需要确认")
        XCTAssertEqual(game.scene.id, target.id)
    }

    func testSceneSwitchAsksThenKeepsGameUntilConfirmed() {
        let game = makeGame()
        let target = targetScene()
        pretendMovesPlayed(game, 4)
        let before = game.scene.id

        game.requestScene(target)

        guard case let .switchScene(scene, moves)? = game.pendingConfirm else {
            return XCTFail("换场景会丢掉这盘棋，同样要先确认")
        }
        XCTAssertEqual(scene.id, target.id)
        XCTAssertEqual(moves, 4)
        XCTAssertTrue(game.pendingConfirm!.message.contains(target.title))
        XCTAssertEqual(game.pendingConfirm!.title, "换一局？")

        // 取消：场景和这盘棋都不能动
        game.pendingConfirm = nil
        XCTAssertEqual(game.scene.id, before)
        XCTAssertEqual(game.history.count, 4)

        // 再来一次并确认：这次才真的换
        game.requestScene(target)
        game.confirmPending()
        XCTAssertEqual(game.scene.id, target.id)
        XCTAssertTrue(game.history.isEmpty)
    }

    func testSceneSwitchMessageCountsMoves() {
        let game = makeGame()
        pretendMovesPlayed(game, 11)
        game.requestScene(targetScene())
        XCTAssertTrue(game.pendingConfirm!.message.contains("11 手"))
    }

    // MARK: - 载入存档

    func testLoadGameAsksWhenThereAreMovesOnTheBoard() {
        let game = makeGame()
        let record = GameRecord(id: "r1", savedAt: Date(), sceneId: "start",
                                sceneName: "存档对局", level: "hard", mode: "engine",
                                startFEN: Rules.startFEN, moves: [], evals: [],
                                flags: GameFlags(), result: "unfinished",
                                finished: false, ply: 0)
        pretendMovesPlayed(game, 7)

        game.requestLoadGame(record)

        guard case let .loadGame(pending, moves)? = game.pendingConfirm else {
            return XCTFail("载入存档会丢弃当前这盘棋，同样要先确认")
        }
        XCTAssertEqual(pending.id, "r1")
        XCTAssertEqual(moves, 7)
        XCTAssertTrue(game.pendingConfirm!.message.contains("存档对局"))
    }

    func testLoadGameOnFreshBoardIsImmediate() {
        let game = makeGame()
        let record = GameRecord(id: "r2", savedAt: Date(), sceneId: "start",
                                sceneName: "存档对局", level: "hard", mode: "engine",
                                startFEN: Rules.startFEN, moves: [], evals: [],
                                flags: GameFlags(), result: "unfinished",
                                finished: false, ply: 0)

        game.requestLoadGame(record)

        XCTAssertNil(game.pendingConfirm)
        XCTAssertEqual(game.scene.title, "存档对局")
    }
}
