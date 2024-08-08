const {Web3} = require("web3");
const BigNumber = require("bignumber.js");
const {contractABI, erc20Abi} = require("./abi");
const {Mutex} = require("./mutex");
const {existsSync, writeFileSync, appendFileSync} = require("fs");
const {join} = require("path");
const {tokenList} = require("./enable");
const logFilePath = join(__dirname, 'log.txt');

//这些数据都不是ETH UNISWAP的地址,需要自己修改
//wss://ethereum-rpc.publicnode.com
const NODE_URL = "ws://183.230.21.141:9944";  //WebSocket endpoint
//const contractAddress = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';  //uniswap v2 router address
const contractAddress = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'; //跟踪合约地址
const followAddress = "" //跟踪钱包地址,为空时不管谁的交易,都跟
const web3 = new Web3(new Web3.providers.WebsocketProvider(NODE_URL));
const ETH_MAX = 0.0001 //使用ethSwapToken时需要
const Deadline = 180  //最大延迟,比pending消息的时间戳延迟,前期交易可能需要授权代币,建议为180s,如果后续继续跟单,建议改成60s
const account = '0x219230D2919Df81cFa143160d0BA79Fb02501054'; //钱包地址
const privateKey = ''; // 私钥不带0x前缀
const mutex = new Mutex();
let nonce //自己维护,这个需要测试可行性
//使用这个节点进行交易和授权,ws节点只进行查询
const trade_url = "https://mainnet.infura.io/v3/623b3c4b"
const web3_trade = new Web3(new Web3.providers.HttpProvider(trade_url));

async function subscribeToPendingTransactions() {
    try {
        //获取nonce
        nonce = await web3.eth.getTransactionCount(account)
        console.log(`Nonce: `, nonce);
        // Subscribe to 'pendingTransactions' event
        const subscription = await web3.eth.subscribe('pendingTransactions');
        console.log(`Subscription successful, Subscription ID: ${subscription.id}`);

        // Event listener for new pending transactions
        subscription.on('data', (tx) => {
            // 获取交易详细信息,只筛选UNISWAP V2 ROUTER
            try {
                queryTx(tx)
            } catch (error) {
                console.error(`get tx message err: ${error}`);
            }

        });

        // Event listener for any errors during the subscription
        subscription.on('error', (error) => {
            console.error('Subscription error:', error);
        });
    } catch (error) {
        console.error(`Error subscribing to pending transactions: ${error}`);
    }
}

async function queryTx(tx) {
    web3.eth.getTransaction(tx)
        .then(async (transaction) => {
            if (transaction) {
                if (transaction.to === contractAddress.toLowerCase()) {
                    if (followAddress !== "") {
                        if (transaction.from !== followAddress) {
                            return
                        }
                    }
                    const input = transaction.input
                    const contract_function = input.slice(0, 10);
                    console.log(transaction)
                    let result
                    switch (contract_function) {
                        case "0x7ff36ab5":
                            await paramFrom0x7ff36ab5or0xfb3bdb41AndFollowTransfer(transaction.input, transaction, "swapExactETHForTokens")
                            break
                        case "0xfb3bdb41":
                            await paramFrom0x7ff36ab5or0xfb3bdb41AndFollowTransfer(transaction.input, transaction, "swapETHForExactTokens")
                            break
                        case "0x18cbafe5":
                            await paramFrom0x18cbafe5or0x4a25d94aAndFollowTransfer(transaction.input, transaction, "swapExactTokensForETH")
                            break
                        case "0x4a25d94a":
                            await paramFrom0x18cbafe5or0x4a25d94aAndFollowTransfer(transaction.input, transaction, "swapTokensForExactETH")
                            break
                        case "0x38ed1739":
                            await paramFrom0x38ed1739or0x8803dbeeAndFollowTransfer(transaction.input, transaction, "swapExactTokensForTokens")
                            break
                        case "0x8803dbee":
                            await paramFrom0x38ed1739or0x8803dbeeAndFollowTransfer(transaction.input, transaction, "swapTokensForExactTokens")
                            break
                        default:
                            console.log("Transaction details method not match ", transaction.hash)
                    }
                } else {
                    console.log("Transaction details not match", tx);
                }
            } else {
                console.error("Error fetching transaction details:", tx);
            }
        })
        .catch(error => {
            console.error("Error fetching transaction details:", tx);
        });
}


const contract = new web3.eth.Contract(contractABI, contractAddress);
const input_amount = BigInt(web3.utils.toWei(ETH_MAX, "ether"))

async function paramFrom0x7ff36ab5or0xfb3bdb41AndFollowTransfer(input, transaction, func) {
    //swapExactETHForTokens
    //swapETHForExactTokens (0xfb3bdb41)
    let parameters = input.slice(10);
    let abiTypes = ['uint256', 'address[]', 'address', 'uint256'];
    let result = web3.eth.abi.decodeParameters(abiTypes, parameters)
    writeLog("[found] - " + transaction.hash + " - " + func + " - ", result)
    //验证账户余额是否充足
    let balance = await queryEthBalance(account)
    if (balance < input_amount) {
        writeLog("[follow] - " + transaction.hash + " - " + "ETH Insufficient balance")
        return
    }
    let param1
    let param2 = result[1]
    let param3 = account
    let param4 = result[3] + BigInt(Deadline)
    let value = input_amount
    if (transaction.value > input_amount) {
        //计算比例
        let a = new BigNumber(transaction.value.toString())
        let b = new BigNumber(input_amount.toString())
        let rate = b.dividedBy(a)
        param1 = BigInt(new BigNumber(result[0].toString()).multipliedBy(rate).integerValue(BigNumber.ROUND_FLOOR).toString())
    } else {
        value = transaction.value
        param1 = result[0]
    }
    const methodArgs = [param1, param2, param3, param4]; // 方法参数
    writeLog("[trade] - " + transaction.hash + " - " + " - " + func + " - " + methodArgs.join(" "))
    const callData = contract.methods[func](...methodArgs).encodeABI();
    await mutex.lock()
    const swap = {
        from: account,
        to: contractAddress,
        gas: transaction.gas,
        gasPrice: transaction.gasPrice,
        data: callData,
        nonce: nonce,
        value: value
    };
    nonce = nonce + BigInt(1)
    await mutex.unlock()
    // 使用私钥签名交易
    sendSwap(swap, privateKey, methodArgs)
}

async function paramFrom0x38ed1739or0x8803dbeeAndFollowTransfer(input, transaction, func) {
    //swapExactTokensForTokens
    //swapTokensForExactTokens (0x8803dbee)
    let parameters = input.slice(10);
    let abiTypes = ['uint256', 'uint256', 'address[]', 'address', 'uint256'];
    let result = web3.eth.abi.decodeParameters(abiTypes, parameters);
    writeLog("[found] - " + transaction.hash + " - " + func + " - ", result)
    let param1
    let param2
    let param3 = result[2]
    let param4 = account
    let param5 = result[4] + BigInt(Deadline)
    let inputToken = result[2][0].toLowerCase()
    //查询token余额
    let balance = await queryERC20Balance(inputToken, account)
    if (balance === BigInt(0)) { //没有余额
        writeLog("[follow] - " + transaction.hash + " - " + " token Insufficient balance,input token " + inputToken)
        return
    }
    if (tokenList.has(inputToken)) {
        let tokenMessage = tokenList.get(inputToken)
        let amountInBigNumber = new BigNumber(tokenMessage.max_trade).multipliedBy(new BigNumber(10).pow(tokenMessage.decimal)).integerValue(BigNumber.ROUND_FLOOR);
        let inputAmount = BigInt(amountInBigNumber.toString());
        if (balance < inputAmount) {
            console.log("token Insufficient balance ", tokenMessage.symbol)
        }
        if (result[0] > inputAmount) {
            param1 = inputAmount
            let a = new BigNumber(result[0].toString())
            let b = new BigNumber(inputAmount.toString())
            let rate = b.dividedBy(a)
            param2 = BigInt(rate.multipliedBy(new BigNumber(result[1].toString)).integerValue(BigNumber.ROUND_FLOOR).toString())
        } else {
            param1 = result[0]
            param2 = result[1]
        }
    } else {//如果配置没有这个token,直接按着跟单的最大值或者钱包token余额
        if (balance > result[0]) {
            param1 = result[0]
            param2 = result[1]
        } else {
            param1 = balance
            let a = new BigNumber(result[0].toString())
            let b = new BigNumber(balance.toString())
            let rate = b.dividedBy(a)
            param2 = BigInt(rate.multipliedBy(new BigNumber(result[1].toString)).integerValue(BigNumber.ROUND_FLOOR).toString())
        }
    }
    //检查授权,第一次使用这个代币的时候才需要,授权直接授权一个相对大的值,后续检查都会通过,不需要去上链授权
    await checkAndApprove(param1, transaction, inputToken)
    //开始交易
    const methodArgs = [param1, param2, param3, param4, param5]; // 方法参数
    writeLog("[trade] - " + transaction.hash + " - " + func + " - " + methodArgs.join(" "))
    const callData = contract.methods[func](...methodArgs).encodeABI();
    await mutex.lock()
    const swap = {
        from: account,
        to: contractAddress,
        gas: transaction.gas,
        gasPrice: transaction.gasPrice,
        data: callData,
        nonce: nonce,
    }
    nonce = nonce + BigInt(1)
    mutex.unlock()
    sendSwap(swap, privateKey, methodArgs)
}

async function paramFrom0x18cbafe5or0x4a25d94aAndFollowTransfer(input, transaction, func) {
    //swapExactTokensForETH
    //swapTokensForExactETH (0x4a25d94a)
    await paramFrom0x38ed1739or0x8803dbeeAndFollowTransfer(input, transaction, func)
}


async function queryEthBalance(address) {
    try {
        return await web3.eth.getBalance(address)
    } catch (err) {
        return BigInt(0)
    }
}

async function queryERC20Balance(erc20ContractAddress, address) {
    const erc20Abi = [
        // 仅包含 balanceOf 函数的 ABI
        {
            "constant": true,
            "inputs": [{"name": "_owner", "type": "address"}],
            "name": "balanceOf",
            "outputs": [{"name": "balance", "type": "uint256"}],
            "type": "function"
        }
    ];

    const erc20Contract = new web3.eth.Contract(erc20Abi, erc20ContractAddress);
    return await erc20Contract.methods.balanceOf(address).call()
}

function sendSwap(swap, privateKey, hash, method) {
    // 使用私钥签名交易
    web3_trade.eth.accounts.signTransaction(swap, privateKey)
        .then(signedTx => {
            // 发送签名的交易
            web3.eth.sendSignedTransaction(signedTx.rawTransaction)
                .on('receipt', receipt => {
                    console.log('Transaction receipt:', receipt);
                    writeLog("[complete] -  " + hash + " - " + receipt + " - " + method.join(" "))
                })
                .on('error', error => {
                    console.error('Error sending transaction:', error);
                    writeLog("[swapfailed] -  " + hash + " - " + error)
                });
        })
        .catch(error => {
            console.error('Error signing transaction:', error);
        });
}

function writeLog(message, result) {
    if (result) {
        let resultMessage = ""
        for (let i = 0; i < result.__length__; i++) {
            resultMessage += result[i] + " ";
        }
        message += resultMessage
    }
    const logMessage = `${new Date().toISOString()} - ${message}\n`;
    if (!existsSync(logFilePath)) {
        writeFileSync(logFilePath, logMessage);
    } else {
        appendFileSync(logFilePath, logMessage);
    }
}

async function checkAndApprove(amount, transaction, tokenAddress) {
    //检查授权金额是否足够
    const tokenContract = new web3.eth.Contract(erc20Abi, tokenAddress);
    const currentAllowance = await tokenContract.methods.allowance(account, contractAddress).call();
    if (currentAllowance > amount) {
        return
    }
    const methodArgs = [contractAddress, BigInt("1000000000000000000000000000000")];
    const callData = contract.methods["approve"](...methodArgs).encodeABI();
    await mutex.lock()
    const approve = {
        from: account,
        to: tokenAddress,
        gas: BigInt(100000),
        gasPrice: transaction.gasPrice,
        data: callData,
        nonce: nonce,
    }
    nonce = nonce + BigInt(1)
    mutex.unlock()
    web3_trade.eth.accounts.signTransaction(approve, privateKey)
        .then(signedTx => {
            // 发送签名的交易
            web3.eth.sendSignedTransaction(signedTx.rawTransaction)
                .on('receipt', receipt => {
                    writeLog("[approve] -  " + receipt + " - " + tokenAddress + " - " + amount)
                })
                .on('error', error => {
                    writeLog("[approvefailed] -  " + tokenAddress + " - " + amount)
                });
        })
        .catch(error => {
            console.error('Error signing transaction:', error);
        });
}

subscribeToPendingTransactions()


async function testFunc() {

    const url = "https://rpc.ankr.com/arbitrum";
    const web31 = new Web3(new Web3.providers.HttpProvider(url));
    const gas = await web31.eth.getGasPrice()
    const nonce = await web31.eth.getTransactionCount("0x219230D2919Df81cFa143160d0BA79Fb02501054")
    const tokenContract = new web31.eth.Contract(erc20Abi, "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9");
    const currentAllowance = await tokenContract.methods.allowance(account, contractAddress).call();
    if (currentAllowance > BigInt(100000)) {
        return
    }


    const methodArgs1 = [contractAddress, BigInt("1000000000000000000000000000000")]; // 方法参数

    const callData1 = tokenContract.methods["approve"](...methodArgs1).encodeABI();
    const app = {
        from: account,
        to: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
        gas: BigInt(100000),
        gasPrice: gas,
        data: callData1,
        nonce: nonce,
    }
    web3.eth.accounts.signTransaction(app, privateKey)
        .then(signedTx => {
            // 发送签名的交易
            web3.eth.sendSignedTransaction(signedTx.rawTransaction)
                .on('receipt', receipt => {
                    console.log('Transaction receipt:', receipt);
                })
                .on('error', error => {
                    console.error('Error sending transaction:', error);
                });
        })
        .catch(error => {
            console.error('Error signing transaction:', error);
        });
    return
    let param1 = BigInt("1000000000000000");
    let param2 = BigInt("1");
    let param3 = ["0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"];
    let param4 = "0x219230D2919Df81cFa143160d0BA79Fb02501054";
    let param5 = BigInt(Math.floor(Date.now() / 1000) + 60 * 20)
    const methodArgs = [param1, param2, param3, param4, param5]; // 方法参数
    const callData = contract.methods["swapExactTokensForTokens"](...methodArgs).encodeABI();
    const swap = {
        from: account,
        to: contractAddress,
        gas: BigInt(200000),
        gasPrice: BigInt("10201000"),
        data: callData,
        nonce: nonce,
    }
    web3.eth.accounts.signTransaction(swap, privateKey)
        .then(signedTx => {
            // 发送签名的交易
            web31.eth.sendSignedTransaction(signedTx.rawTransaction)
                .on('receipt', receipt => {
                    console.log('Transaction receipt:', receipt);
                })
                .on('error', error => {
                    console.error('Error sending transaction:', error);
                });
        })
        .catch(error => {
            console.error('Error signing transaction:', error);
        });

}



