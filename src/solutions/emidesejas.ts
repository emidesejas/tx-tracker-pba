import type {
  API,
  FinalizedEvent,
  IncomingEvent,
  NewBlockEvent,
  NewTransactionEvent,
  OutputAPI,
} from "../types"

export default function emidesejas(api: API, outputApi: OutputAPI) {
  // Requirements:
  //
  // 1) When a transaction becomes "settled"-which always occurs upon receiving a "newBlock" event-
  //    you must call `outputApi.onTxSettled`.
  //
  //    - Multiple transactions may settle in the same block, so `onTxSettled` could be called
  //      multiple times per "newBlock" event.
  //    - Ensure callbacks are invoked in the same order as the transactions originally arrived.
  //
  // 2) When a transaction becomes "done"-meaning the block it was settled in gets finalized-
  //    you must call `outputApi.onTxDone`.
  //
  //    - Multiple transactions may complete upon a single "finalized" event.
  //    - As above, maintain the original arrival order when invoking `onTxDone`.
  //    - Keep in mind that the "finalized" event is not emitted for all finalized blocks.
  //
  // Notes:
  // - It is **not** ok to make redundant calls to either `onTxSettled` or `onTxDone`.
  // - It is ok to make redundant calls to `getBody`, `isTxValid` and `isTxSuccessful`
  //
  // Bonus 1:
  // - Avoid making redundant calls to `getBody`, `isTxValid` and `isTxSuccessful`.
  //
  // Bonus 2:
  // - Upon receiving a "finalized" event, call `api.unpin` to unpin blocks that are either:
  //     a) pruned, or
  //     b) older than the currently finalized block.

  const blocks = new Map<string, { parent: string }>()
  const trackedTransactions: Map<string, { invalidInBlock: Set<string> }> =
    new Map()

  let lastFinalizedBlock: string | null = null

  const onNewBlock = ({ blockHash, parent }: NewBlockEvent) => {
    const blockData = { parent }
    blocks.set(blockHash, blockData)

    const body = new Set(api.getBody(blockHash))

    trackedTransactions.forEach((_value, tx) => {
      if (body.has(tx)) {
        outputApi.onTxSettled(tx, {
          blockHash,
          type: "valid",
          successful: api.isTxSuccessful(blockHash, tx),
        })
      } else if (!api.isTxValid(blockHash, tx)) {
        outputApi.onTxSettled(tx, { blockHash, type: "invalid" })
        trackedTransactions.get(tx)?.invalidInBlock.add(blockHash)
      }
    })
  }

  const onNewTx = ({ value: transaction }: NewTransactionEvent) => {
    trackedTransactions.set(transaction, { invalidInBlock: new Set<string>() })
  }

  const onFinalized = ({ blockHash }: FinalizedEvent) => {
    if (lastFinalizedBlock === null) {
      lastFinalizedBlock = blockHash
    }

    let currentBlock = blockHash
    const blocksToUnpin = []

    do {
      const body = new Set(api.getBody(currentBlock))

      trackedTransactions.forEach((_value, tx) => {
        if (body.has(tx)) {
          outputApi.onTxDone(tx, {
            blockHash: currentBlock,
            type: "valid",
            successful: api.isTxSuccessful(currentBlock, tx),
          })

          trackedTransactions.delete(tx)
        } else if (trackedTransactions.get(tx)?.invalidInBlock.has(blockHash)) {
          outputApi.onTxDone(tx, { blockHash: currentBlock, type: "invalid" })
        }
      })

      const blockData = blocks.get(currentBlock)

      blocksToUnpin.push(currentBlock)

      if (!blockData) {
        break
      }

      blocks.delete(currentBlock)

      currentBlock = blockData.parent

      if (!currentBlock) {
        break
      }
    } while (currentBlock !== lastFinalizedBlock)

    api.unpin(blocksToUnpin)

    lastFinalizedBlock = blockHash
  }

  return (event: IncomingEvent) => {
    switch (event.type) {
      case "newBlock": {
        onNewBlock(event)
        break
      }
      case "newTransaction": {
        onNewTx(event)
        break
      }
      case "finalized":
        onFinalized(event)
    }
  }
}
