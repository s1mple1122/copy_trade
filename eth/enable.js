const tokenList = new Map();

//未在列表的代币,如果钱包存在,也会跟着做交易
tokenList.set("0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1".toLowerCase(), {
    "symbol": "DAI",
    "decimal": 18,
    "max_trade": 0.001,  //配置这个之后,如果当前代币的钱包余额不足这个数量,不会进行交易
})

module.exports = {tokenList};
