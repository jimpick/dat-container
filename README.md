# pipette-hugo-worker

"Pipette" is a blogging platform built on top of Dat, Beaker Browser, Netlify CMS and Hugo.

# Install

```
npm install -g pipette-hugo-worker
```

Requires systemd-nspawn and fuse installed on Linux.

*(Detailed install instructions coming soon)*

## Development Blog

Pipette is under active development. Please follow the blog here:

* https://pipette-dev-blog-jimpick.hashbase.io/
* [dat://pipette-dev-blog-jimpick.hashbase.io/](dat://pipette-dev-blog-jimpick.hashbase.io/)

Introduction to the project:

* [Introducing Pipette](https://pipette-dev-blog-jimpick.hashbase.io/post/introducing-pipette/)

## Usage

**Note:** For now, Pipette needs to run as the root user as it needs to create a virtual machine using systemd-nspawn.

``` sh
# pipette-hugo-worker dat://d6185c1680001cd2260a0f31bfb209edbf97551774dc6175c110019d9020199d/
```

Replace the dat:// url with the address of a Dat archive containing the blog contents and configuration. (see below)

This command will create a 'hugo-worker' subdirectory beneath the current directory. It will then download and spawn a lightweight virtual machine which will subscribe to the specified Dat archive, and then run the [Hugo](https://gohugo.io/) static site generator every time you create, edit or delete a blog post.

It will automatically create and share a new Dat archive containing the files for the generated static site. Look at the logs for a line that says `Static site url: dat://...` for the address.

Once you have the address, one thing you might want to do is to register it with [Hashbase](https://hashbase.io/) to get another peer and to automatically publish it to the conventional web via HTTPS.

## Creating your own source Dat archive

To create a new source archive, you can use [Beaker Browser](https://beakerbrowser.com/) to fork the source "CMS" (Content Management System) for the development blog:

* [dat://d6185c1680001cd2260a0f31bfb209edbf97551774dc6175c110019d9020199d/](dat://d6185c1680001cd2260a0f31bfb209edbf97551774dc6175c110019d9020199d/)

Once you have forked it, you can erase the content and change the blog title and description in the Settings menu.


## Acknowledgements

The starting point for this code was: https://github.com/mafintosh/dat-container

## License

MIT
