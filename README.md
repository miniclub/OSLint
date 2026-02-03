# ObjectScript Lint (OSLint)

## 概要

コマンドラインより指定されたクラスやルーチンの構文チェックを行う
構文チェックロジックは以下のURLから取得
https://github.com/intersystems/language-server

## 使用方法

### インストール、ビルド

```
npm install
npm run webpack
```

### 実行

```
node out/lint.js C:\path\to\My.cls C:\path\to\My.mac
```

### 出力例

```
C:\path\to\My.mac:12:5: error: Syntax error (syntax)
C:\path\to\My.mac:20:10: warning: Local variable "x" may be undefined (undefined-vars)
```

### 主なオプション

+ --format json で JSON 出力
+ -l, --language objectscript-class で言語IDを強制
+ --no-undefined-vars / --no-syntax
+ --no-routine-header（ROUTINEヘッダー必須チェックを無効化

## 構文チェックロジックの更新

+ /lib フォルダをlanguage-serverの server/libからコピー
+ /src/parse/parse.tsをserver/src/parse/parse.tsからコピー
+ /src/parse/routineheader/*をserver/src/parse/routineheaderからコピー
+ /src/parse/utils/*をserver/src/parse/utilsからコピー


