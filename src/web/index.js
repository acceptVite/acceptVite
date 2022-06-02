const { EventEmitter } = require('events')
const http = require('http')

const request = (address, JSONdata) => {
  const url = new URL(address)
  const data = JSON.stringify(JSONdata)

  const options = {
    hostname: url.hostname,
    port: url.port,
    path: url.path,
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
    }
  }

  const req = http.request(options, (res) => {
  }).on("error", (err) => { console.log(err) })

  req.write(data)
  req.end()
}

class WebServer extends EventEmitter {
  constructor(port) {
    super()

    const requestListener = async (req, res) => {
      const parsedUrl = new URL(`https://webserver.xyz${req.url}`)
    
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'version': 'v1.0'
      })
    
      const endpoint = parsedUrl.pathname.split('/')[1]
      const params = Object.fromEntries(parsedUrl.searchParams)
  
      this.emit('request', { endpoint, params }, res)
    }
    
    const serverObject = http.createServer(requestListener)
    serverObject.listen(port)
  }
}

module.exports = { WebServer, request }