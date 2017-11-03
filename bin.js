#!/usr/bin/env node

var fuse = require('fuse-bindings')
var fs = require('fs')
var { join, resolve } = require('path')
var hyperdrive = require('hyperdrive')
var hyperdiscovery = require('hyperdiscovery')
var Dat = require('dat-node')
var pager = require('memory-pager')
var minimist = require('minimist')
var mkdirp = require('mkdirp')
var proc = require('child_process')
var rimraf = require('rimraf')

const linuxImageKey = '64142950c48086928090f1e319f9a7b40faa79219c0a14a89c0671cfdcaf1b01'
const linuxImageFile = '/debian-jessie-with-node.img'
const hugoWorkerImageKey = 'b555cda8b9e3a1865fa4a04ef40afa059f7131bd03051cbf63c62a085ec4169c'
const hugoWorkerImageFile = '/worker.img'

// const primerKey = '928839a120518291510ca23acdeee379866f99738b00f7dedc04d18e07c4bff8'
// const primerTarball = 'hugo-worker-build-with-hugo-smaller.tar.xz'
const primerKey = 'fe8c2c7185948fe5636daaf9e7f9f0987934209714f023a8015494b749875f83'
const primerTarball = 'hugo-worker-sparse.tar.gz'

let loopDevice

var argv = minimist(process.argv.slice(2), {
  alias: {
    boot: 'b',
    dir: 'd'
  },
  boolean: [
    'subscribe',
    'dat-share'
  ],
  default: {
    dir: 'hugo-worker',
    subscribe: true,
    'dat-share': true
  }
})

if (process.getuid() !== 0) {
  console.error('Need to be root')
  process.exit(2)
}

var indexLoaded = false
var nspawn = null
var losetup = null
var storage = (!argv.ram && !argv.index) ? join(argv.dir, './archive') : require('random-access-memory')
var archive
var storageWorker = join(argv.dir, './archiveWorker')
var archiveWorker

var track = argv.index ? fs.createWriteStream(argv.index) : null
var mirrored = join(argv.dir, './tmp')
var mnt = join(argv.dir, './mnt')
var mntWorker = join(argv.dir, './mntWorker')
var workerPath = resolve(join(argv.dir, 'worker'))
var writtenBlocks = pager(4096)
var writtenBlocksWorker = pager(4096)
var totalDownloaded = 0
var blocks = 0
var lastBlocks = []

var range = null
var rangeWorker = null
var bufferSize = parseInt(argv.buffer || 0, 10)

process.on('SIGINT', sigint)


function mount (mnt, archive, writtenBlocks, imageFile, cb) {
  fuse.mount(mnt, {
    readdir: function (path, cb) {
      if (isMirrored(path)) fs.readdir(mirrored + path, done)
      else archive.readdir(path, done)

      function done (err, folders) {
        if (err) return cb(toErrno(err))
        cb(0, folders)
      }
    },
    getattr: function (path, cb) {
      if (isMirrored(path)) fs.lstat(mirrored + path, done)
      else archive.lstat(path, done)

      function done (err, st) {
        if (err) return cb(toErrno(err))
        cb(null, st)
      }
    },
    unlink: function (path, cb) {
      if (isMirrored(path)) fs.unlink(mirrored + path, done)
      else archive.unlink(path, done)

      function done (err) {
        if (err) return cb(toErrno(err))
        cb(0)
      }
    },
    create: function (path, mode, cb) {
      fs.open(mirrored + path, 'w', mode, done)

      function done (err, fd) {
        if (err) return cb(toErrno(err))
        cb(0, fd)
      }
    },
    open: function (path, flags, cb) {
      if (isMirrored(path)) fs.open(mirrored + path, flags, done)
      else archive.open(path, flags, {download: false}, done)

      function done (err, fd) {
        if (err) return cb(toErrno(err))
        cb(0, fd)
      }
    },
    release: function (path, fd, cb) {
      if (isMirrored(path)) fs.close(fd, done)
      else archive.close(fd, done)

      function done (err) {
        cb(err ? err.errno : -1, 0)
      }
    },
    write: function (path, fd, buf, len, pos, cb) {
      var offset = pos & 4095
      var page = (pos - offset) / 4096
      var blk = writtenBlocks.get(page)
      buf.copy(blk.buffer, offset)
      cb(len)
    },
    read: function (path, fd, buf, len, pos, cb) {
      var totalRead = 0

      run(fd, buf, 0, len, pos, done)

      function done (err, read) {
        if (err) return cb(toErrno(err))
        totalRead += read
        if (!read || totalRead === len) return cb(totalRead)
        run(fd, buf, totalRead, len - totalRead, pos + totalRead, done)
      }

      function run (fd, buf, offset, len, pos, done) {
        if (path === imageFile) {
          var overflow = pos & 4095
          var page = (pos - overflow) / 4096
          var blk = writtenBlocks.get(page, true)

          if (blk) {
            var b = blk.buffer
            if (b.length > len) b = b.slice(0, len)
            if (overflow) b = b.slice(overflow)
            b.copy(buf, offset, 0, b.length)
            return process.nextTick(done, null, b.length)
          }
        }

        if (isMirrored(path)) fs.read(fd, buf, offset, len, pos, done)
        else archive.read(fd, buf, offset, len, pos, done)
      }
    }
  }, function (err) {
    if (err) throw err
    cb()
  })
}

function isMirrored (name) {
  return /\/\./.test(name) || !/\.img$/.test(name)
}

function toErrno (err) {
  if (err.errno) return err.errno
  if (err.notFound) return fuse.ENOENT
  return -1
}

function sigint () {
  if (nspawn) return process.kill(nspawn.pid, 'SIGKILL')
  unmount(mnt, function () {
    process.exit(1)
  })
}

function onstats () {
  console.log('(Stats server listening on 10000)')
  require('http').createServer(function (req, res) {
    var interval = setInterval(stats, 1000)
    stats()
    res.on('close', function () {
      clearInterval(interval)
    })

    function stats () {
      res.write('Bytes downloaded  : ' + totalDownloaded + '\n')
      res.write('Blocks downloaded : ' + blocks + '\n')
      res.write('Last blocks       : ' + lastBlocks.join(' ') + '\n')
    }
  }).listen(10000)
}

function checkIndex () {
  archive.readFile(linuxImageFile + '.index', function (_, buf) {
    if (!buf) return
    indexLoaded = true

    var btm = 0
    var indexes = buf.toString('utf-8').trim().split('\n').map(function (n) {
      return parseInt(n, 10)
    })

    archive.once('content', update)
    update()

    function update () {
      if (!archive.content) return

      while (btm < indexes.length) {
        if (archive.content.has(indexes[btm])) {
          btm++
        } else {
          break
        }
      }

      var missing = 5

      for (var i = btm; i < indexes.length && missing; i++) {
        var idx = indexes[i]
        if (archive.content.has(idx)) continue
        missing--
        if (downloading(idx)) continue
        archive.content.download(idx, update)
      }
    }

    function downloading (index) {
      for (var i = 0; i < archive.content._selections.length; i++) {
        var s = archive.content._selections[i]
        if (s.start <= index && index < s.end) return true
      }
      return false
    }
  })
}

function check () {
  if (!indexLoaded) checkIndex()
  if (losetup || nspawn) return
  archive.stat(linuxImageFile, function (err, st) {
    if (err || losetup || nspawn) return

    archiveWorker.stat(hugoWorkerImageFile, function (err, st) {
      if (err || losetup || nspawn) return

      // Mount worker image on loopback device using losetup
      let workerImage = join(argv.dir, 'mntWorker', hugoWorkerImageFile)
      if (argv['worker-image']) {
        console.log('Using override worker image:', argv['worker-image'])
        workerImage = argv['worker-image']
      }
      // Figure out if we are using BusyBox losetup (eg. inside HyperOS)
      let busyBox = true
      try {
        proc.execSync('losetup 2>&1 | grep -q BusyBox')
      } catch (err) {
        // The grep above should fail on a non-BusyBox system
        busyBox = false
      }
      if (!busyBox) {
        console.log('BusyBox detected!')
      }
      const args = []
      let workerLoopDevice
      if (busyBox) {
        workerLoopDevice = '/dev/loop0'
        args.push(workerLoopDevice)
      } else {
        args.push('--find')
        args.push('--show')
      }
      args.push(workerImage)
      losetup = proc.spawn('losetup', args)
      losetup.stdout.on('data', data => {
        workerLoopDevice = data.toString().split('\n')[0]
      })
      losetup.on('exit', code => {
        if (code) {
          console.error('losetup non-zero status', code)
          process.exit(1)
        }
        if (!workerLoopDevice) {
          console.error('Invalid workerLoopDevice')
          process.exit(1)
        }
        console.log('Worker loop device:', workerLoopDevice)

        if (nspawn) return

        let linuxImage = join(mnt, linuxImageFile)
        if (argv['linux-image']) {
          console.log('Using override linux image:', argv['linux-image'])
          linuxImage = argv['linux-image']
        }

        var args = ['-i', linuxImage]
        if (argv.boot) args.push('-b')
        else if (argv.quiet !== false) args.push('-q')
        if (argv.bind) args.push('--bind', argv.bind)
        args.push(`--bind=${workerLoopDevice}:/dev/loop0`)
        args.push(`--bind=${workerPath}:/mnt`)
        args.push(`--register=no`)

        Object.keys(argv).forEach(function (k) {
          if (k.slice(0, 3) === 'sn-') {
            args.push('--' + k.slice(3))
            if (argv[k] !== true) args.push(argv[k])
          }
        })

        let workerArgs = []
        if (!argv.subscribe) {
          workerArgs.push('--no-subscribe')
        }
        if (!argv['dat-share']) {
          workerArgs.push('--no-dat-share')
        }
        workerArgs = workerArgs.concat(argv._)
        const startScript = `#! /bin/bash
set -e
mount /dev/loop0 /home/worker
su -l worker -c '
cd /home/worker/dat-subscribe-worker
node index.js ${workerArgs.join(' ')}
'
`
        console.log('Worker args:', workerArgs.join(' '))
        fs.writeFileSync(`${argv.dir}/worker/start.sh`, startScript)

        let workerImage = join(argv.dir, 'mntWorker', hugoWorkerImageFile)
        args.push('bash')
        args.push('/mnt/start.sh')

        process.removeListener('SIGINT', sigint)
        console.log('systemd-nspawn', args.join(' '))
        nspawn = proc.spawn('systemd-nspawn', args, {
          stdio: 'inherit'
        })
        nspawn.on('exit', function (code) {
          console.log('Unmounting', mnt)
          unmount(mnt, function () {
            console.log('Deleting loop device', workerLoopDevice)
            const losetupDelete = proc.spawn(
              'losetup',
              [
                '-d',
                workerLoopDevice
              ]
            )
            losetupDelete.on('close', () => {
              console.log('Unmounting', mntWorker)
              unmount(mntWorker, function () {
                process.exit(code)
              })
            })
          })
        })
      })
      losetup.on('error', error => {
        console.log('Error', error)
        process.exit(1)
      })

    })
  })

}

function unmount (mnt, cb) {
  proc.spawn('umount', ['-f', mnt]).on('exit', cb)
}

function downloadPrimer(primerDir) {
  const promise = new Promise((resolve, reject) => {
    console.log('Downloading primer...')
    Dat(primerDir, { key: primerKey }, (err, dat) => {
      if (err) {
        return reject(err)
      }
      const network = dat.joinNetwork()
      network.once('connection', function () {
        console.log('Connected')
      })
      dat.joinNetwork()
      dat.archive.metadata.update(() => {
        setTimeout(() => {
          dat.archive.download(() => {
            console.log('Primer downloaded.')
            dat.leaveNetwork()
            resolve()
          })
        }, 1000)
      })
    })
  })
  return promise
}

function startVirtualMachine () {
  const promise = new Promise((resolve, reject) => {
    archive = hyperdrive(storage, linuxImageKey, {
      createIfMissing: false,
      sparse: true
    })
    archiveWorker = hyperdrive(storageWorker, hugoWorkerImageKey, {
      createIfMissing: false,
      sparse: true
    })
    archive.once('content', function () {
      archive.content.allowpush = true
      archive.content.on('download', function (index, data) {
        if (track) track.write('' + index + '\n')
        if (range) archive.content.undownload(range)
        if (bufferSize) {
          range = archive.content.download({
            start: index,
            end: Math.min(archive.content.length, index + bufferSize),
            linear: true
          })
        }

        totalDownloaded += data.length
        blocks++
        lastBlocks.push(index)
        if (lastBlocks.length > 5) lastBlocks.shift()
      })
    })

    if (argv.stats) onstats()

    archive.on('ready', function () {
      hyperdiscovery(archive, {live: true})
    })

    archiveWorker.once('content', function () {
      archiveWorker.content.allowPush = true
      archiveWorker.content.on('download', function (index, data) {
        if (rangeWorker) archiveWorker.content.undownload(rangeWorker)
        if (bufferSize) {
          rangeWorker = archiveWorker.content.download({
            start: index,
            end: Math.min(archive.content.length, index + bufferSize),
            linear: true
          })
        }
      })
    })

    archiveWorker.on('ready', function () {
      hyperdiscovery(archiveWorker, {live: true})
    })

    unmount(mnt, () => {
      unmount(mntWorker, () => {
        mount(mnt, archive, writtenBlocks, linuxImageFile, () => {
          console.log('Linux image mounted')
          mount(mntWorker, archiveWorker, writtenBlocksWorker, hugoWorkerImageFile, () => {
            console.log('Worker image mounted')
            check()
            archive.metadata.on('remote-update', check)
            archive.metadata.on('append', check)
            archiveWorker.metadata.on('remote-update', check)
            archiveWorker.metadata.on('append', check)
          })
        })
      })
    })
  })
  return promise
}

async function run () {

  if (!fs.existsSync(argv.dir)) {
    if (argv.dir !== '.') {
      const primerDir = join(argv.dir, 'primer')
      mkdirp.sync(primerDir)
      await downloadPrimer(primerDir)
      console.log('Unpacking primer')
      proc.execSync(`tar xf ${primerDir}/${primerTarball} hugo-worker -C ${argv.dir}`)
      rimraf.sync(primerDir)
    }
  }

  mkdirp.sync(mirrored)
  mkdirp.sync(mnt)
  mkdirp.sync(mntWorker)
  mkdirp.sync(workerPath)
  fs.chmodSync(workerPath, 0777)
  await startVirtualMachine()

}

run()

