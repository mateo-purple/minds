# 完全オンライン化の実装計画

## 結論

GitHubへ上げるのは正しい第一歩ですが、それだけでは対戦サーバーは動きません。
GitHubはコード保管・履歴管理に使い、Node.js + Socket.IOサーバーをRenderやRailwayなどのWebサービスへデプロイします。

現在のv17は「ホスト端末がゲーム本体を動かすβ」です。完全オンラインにするには、ゲームの正解となる状態をサーバーだけが保持する方式へ変更します。

## 必須の構成

1. ブラウザクライアント
   - 盤面を表示する
   - 自分の手札と秘密情報だけを表示する
   - 「このカードを使いたい」「このマスへ置きたい」という操作要求だけ送る
   - 勝手に山札、職業、報酬を変更しない

2. 権威サーバー（Node.js + Socket.IO）
   - 山札の生成とシャッフル
   - 手札配布
   - 職業配布
   - カード使用と道配置の合法性判定
   - 手番管理
   - ゴール到達判定
   - 報酬分配
   - NPC思考
   - 切断・再接続
   - 対戦ログ

3. データベース
   - アカウント
   - レート
   - 累計報酬
   - 対戦履歴
   - BANや通報情報を将来追加する場合の基盤

4. Redis（複数サーバーへ増やす段階）
   - Socket.IOのルーム情報を複数インスタンスで共有
   - 最初の小規模運用では1インスタンスでも構わない

## 絶対に全員へ送ってはいけない情報

- 他人の手札
- 他人の職業
- 他人だけが確認したゴール情報
- NPCの内部推測
- 恨み値、恩義、冷酷CPUの利益計画
- 山札の並び順

サーバーは次の2種類に分けて送信します。

### 公開状態

- 盤面
- 手番
- プレイヤー名
- 手札枚数
- 公開デバフ
- 公開済みゴール
- 山札残数
- チャット

### 個人状態

- 自分の手札
- 自分の職業
- 自分だけが知るゴール
- 自分だけが知る職業
- 自分の使用可能操作

## 推奨イベント

クライアントからサーバー：

- `match:create`
- `match:join`
- `match:resume`
- `action:play_card`
- `action:place_path`
- `action:select_player`
- `action:select_goal`
- `action:discard`
- `action:exchange_draw`
- `action:end_turn`
- `chat:send`

サーバーから全員：

- `match:public_state`
- `match:action_result`
- `match:turn_changed`
- `match:ended`
- `chat:message`

サーバーから本人だけ：

- `match:private_state`
- `match:action_rejected`
- `match:secret_result`

## 現在のコードからの移行順

### 第1段階

`index.html`内の純粋なルール関数を`shared/gameRules.js`へ分離します。

- `canPlacePath`
- `computeReachable`
- `tilePorts`
- `awardVictoryPool`
- カード定義
- ステージ定義

DOM操作、音、演出は移しません。

### 第2段階

`server/gameEngine.js`を作り、次を移します。

- `makeState`
- `buildDeck`
- `beginTurn`
- `advanceTurn`
- `executeAiAction`
- `finishGame`

### 第3段階

ブラウザ側のカード処理を削り、Socket.IOへ操作要求を送るだけにします。

悪い例：

```js
state.board[y][x] = tile;
```

完全オンライン版：

```js
socket.emit('action:place_path', { cardId, x, y, rotation });
```

サーバーが合法性を確認してから状態を更新します。

### 第4段階

プレイヤーごとの表示データを作ります。

```js
function stateForPlayer(match, playerId) {
  return {
    publicState: buildPublicState(match),
    privateState: buildPrivateState(match, playerId),
  };
}
```

### 第5段階

再接続用に、ブラウザへランダムなセッショントークンを保存します。
Socket IDは再接続時に変わるため、本人識別へ直接使い続けてはいけません。

## GitHubへ上げる手順

プロジェクトフォルダーで実行します。

```bash
git init
git add .
git commit -m "Initial online mine game"
git branch -M main
git remote add origin https://github.com/ユーザー名/リポジトリ名.git
git push -u origin main
```

GitHub Desktopを使う場合は、フォルダーを追加して「Publish repository」でも構いません。

## Renderへ仮公開する手順

1. GitHubへこのフォルダーをpush
2. RenderでNew Web Service
3. GitHubリポジトリを接続
4. Build Command: `npm install`
5. Start Command: `npm start`
6. Health Check Path: `/health`
7. 発行されたHTTPS URLを共有

現在のロビーβはこれでインターネットから接続できます。ただし、盤面完全同期には上記のサーバー権威化が必要です。

## データ保存の注意

現在の`ratings.json`は簡易版です。クラウドでは再起動や再デプロイで消える可能性があります。
本番ではPostgreSQLへ置き換えてください。

最低限のテーブル例：

- `users`
- `ratings`
- `campaign_rewards`
- `matches`
- `match_players`

## 不正対策

- クライアントが送った座標・カードIDを必ず検証
- 自分の手札にないカードは拒否
- 自分の手番でなければ拒否
- 使用済み行動枠なら拒否
- レート結果をホスト申告だけで確定しない
- サーバーが勝敗を確定する
- チャットへレート制限を入れる

## テスト項目

- 同時に2人がカードを使った場合
- 手番中に切断した場合
- 再接続した場合
- ゴール確認情報が他人へ漏れないこと
- 職業交換後の秘密情報
- NPC入りルーム
- 山札999枚のモアカオス
- 部屋のホストが退出した場合
- サーバー再起動時の扱い
