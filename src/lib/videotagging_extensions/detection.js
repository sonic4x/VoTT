const DetectionAlgorithmManager = require('../detection_algorithm_manager').DetectionAlgorithmManager;
const path = require('path');
const fs = require('fs');

function Detection(videotagging, visitedFrames) {
    this.videotagging = videotagging;
    this.visitedFrames = visitedFrames;
    this.detectionAlgorithmManager = new DetectionAlgorithmManager();

    var self = this;

    //maps every frame in the video to an imageCanvas until a specified point NOTE mapVideo clears the oncanplay eventListener
    this.mapVideo = function (frameHandler, until) {
        return new Promise((resolve, reject) => {
            //init canvas buffer
            var frameCanvas = document.createElement("canvas");
            frameCanvas.width = self.videotagging.video.videoWidth;
            frameCanvas.height = self.videotagging.video.videoHeight;
            var canvasContext = frameCanvas.getContext("2d");

            // start exporting frames using the canplay eventListener
            self.videotagging.video.oncanplay = iterateFrames;
            self.videotagging.video.currentTime = 0;
            self.videotagging.playingCallback();

            //resolve export until
            var isLastFrame;
            if (until === "tagged") {
                isLastFrame = function (frameId) {
                    return (!Object.keys(self.videotagging.frames).length) || (frameId >= parseInt(Object.keys(self.videotagging.frames)[Object.keys(self.videotagging.frames).length - 1]));
                }
            }
            else if (until === "visited") {
                isLastFrame = function (frameId) {
                    var lastVisitedFrameId = Math.max.apply(Math, Array.from(self.visitedFrames));
                    return (frameId >= lastVisitedFrameId);
                }
            }
            else { //last
                isLastFrame = function (frameId) {
                    return (self.videotagging.video.currentTime >= self.videotagging.video.duration);
                }
            }

            function iterateFrames() {
                var frameId = self.videotagging.getCurrentFrame();
                var lastFrame = isLastFrame(frameId);

                if (lastFrame) {
                    self.videotagging.video.oncanplay = null;
                    resolve();
                }

                var frameName = `${path.basename(self.videotagging.src, path.extname(self.videotagging.src))}_frame_${frameId}.jpg`
                frameHandler(frameName, frameId, frameCanvas, canvasContext, (err) => {
                    if (err) {
                        reject(err);
                    }
                    if (!lastFrame) {
                        self.videotagging.stepFwdClicked(false);
                    }
                })
            }
        });
    }

    //this maps dir of images for exporting
    this.mapDir = function (frameHandler, dir) {
        return new Promise((resolve, reject) => {
            imagesProcessed = 0;
            dir.forEach((imagePath, index) => {
                var img = new Image();
                img.src = imagePath;
                img.onload = function () {
                    var frameCanvas = document.createElement("canvas");
                    frameCanvas.width = img.width;
                    frameCanvas.height = img.height;
                    // Copy the image contents to the canvas
                    var canvasContext = frameCanvas.getContext("2d");
                    canvasContext.drawImage(img, 0, 0);
                    frameHandler(path.basename(imagePath), index, frameCanvas, canvasContext, (err) => {
                        if (err) {
                            reject(err);
                        }
                        imagesProcessed += 1;
                        if (imagesProcessed == dir.length) {
                            resolve();
                        }
                    });
                }
            });
        });
    }

    // TODO: Abstract to a module that receives a "framesReader" object as input
    //exports frames to the selected detection algorithm format  for model training
    this.export = function (dir, method, exportUntil, exportPath, testSplit, cb) {
        self.detectionAlgorithmManager.initExporter(method, exportPath, self.videotagging.inputtagsarray,
            Object.keys(self.videotagging.frames).length,
            self.videotagging.video.videoWidth,
            self.videotagging.video.videoHeight,
            testSplit,
            (err, exporter) => {
                if (err) {
                    cb(err);
                }
                if (dir) {
                    this.mapDir(exportFrame.bind(err, exporter), dir).then(exportFinished, (err) => {
                        console.info(`Error on ${method} init:`, err);
                        cb(err);
                    });

                } else {
                    this.mapVideo(exportFrame.bind(err, exporter), exportUntil).then(exportFinished, (err) => {
                        console.info(`Error on ${method} init:`, err);
                        cb(err);
                    });
                }

                function exportFinished() {
                    let notification = new Notification('Offline Video Tagger', {
                        body: `Successfully exported ${method} files.`
                    });
                    cb();
                }

            });

        function exportFrame(exporter, frameName, frameId, frameCanvas, canvasContext, frameExportCb) {
            if (!self.visitedFrames.has(frameName)) {
                return frameExportCb();
            }
            var frameTags = [];
            var frames = self.videotagging.frames;

            //confirm that frame is tagged and that no tags are unlabeled 
            // FrameId or FrameName
            var frameIsTagged = !!frames[frameName]
            var frame = frames[frameName] || []
            
            
            // if (frameIsTagged && (self.videotagging.getUnlabeledRegionTags(frameId).length != self.videotagging.frames[frameId].length)) {
            if (frameIsTagged){
                //genereate metadata from tags
                frame.map((tag) => {
                    if (!tag.tags[tag.tags.length - 1]) {
                        return console.log(`frame ${frameId} region ${tag.name} has no label`);
                    }
                    var stanW = (self.videotagging.imagelist) ? frameCanvas.width / tag.width : self.videotagging.video.videoWidth / tag.width;
                    var stanH = (self.videotagging.imagelist) ? frameCanvas.height / tag.height : self.videotagging.video.videoHeight / tag.height;
                    var tag = {
                        class: tag.tags[tag.tags.length - 1],
                        x1: parseInt(tag.x1 * stanW),
                        y1: parseInt(tag.y1 * stanH),
                        x2: parseInt(tag.x2 * stanW),
                        y2: parseInt(tag.y2 * stanH)
                    };
                    if (self.videotagging.imagelist) {
                        tag.w = parseInt(frameCanvas.width);
                        tag.h = parseInt(frameCanvas.height);
                    }
                    frameTags.push(tag);

                });
            }

            //draw the frame to the canvas
            var buf = self.canvasToJpgBuffer(frameCanvas, canvasContext);
            exporter(frameName, buf, frameTags)
                .then(() => {
                    frameExportCb();
                }, (err) => {
                    console.info('Error occured when trying to export frame', err);
                    frameExportCb(err);
                });
        }
    }

    //allows user to review model suggestions on a video
    this.review = function(dir, method, modelPath, reviewPath, cb) {
        //if the export reviewPath directory does not exist create it and export all the frames then review
        fs.exists(reviewPath, (exists) => {
            if (!exists){
                fs.mkdir(reviewPath, (err) => {
                    if (err){
                        cb(err);
                    }
                    if (dir){
                        this.mapDir(saveFrame, dir).then( () => {
                            reviewModel();
                        });                        
                    } else {
                        this.mapVideo(saveFrame, "last").then( () => {
                            reviewModel();
                        });                        
                    }
                });
            } else {
                reviewModel();
            }
        
            function reviewModel() {
                //run the model on the reviewPath directory
                self.detectionAlgorithmManager.initReviewer(method, modelPath, (reviewImagesFolder) => {
                    reviewImagesFolder(reviewPath).then(modelTags => {
                        self.videotagging.frames = {};
                        self.videotagging.optionalTags.createTagControls(Object.keys(modelTags.classes));

                        //Create regions based on the provided modelTags
                        var p = new Promise ((resolve, reject) => {
                            Object.keys(modelTags.frames).map((pathId) => {
                                var frameImage = new Image();
                                frameImage.src = path.join(reviewPath, pathId);
                                frameImage.onload = loadFrameRegions; 

                                function loadFrameRegions() {
                                    var imageWidth = this.width;
                                    var imageHeight = this.height;
                                    frameId = pathId.replace(".jpg", "");//remove.jpg
                                    console.log(frameId)
                                    self.videotagging.frames[frameId] = [];
                                    modelTags.frames[pathId].regions.forEach( (region) => {
                                        self.videotagging.frames[frameId].push({
                                        x1:region.x1,
                                        y1:region.y1,
                                        x2:region.x2,
                                        y2:region.y2,                          
                                        id:self.videotagging.uniqueTagId++,
                                        width:imageWidth,
                                        height:imageHeight,
                                        type:self.videotagging.regiontype,
                                        tags:Object.keys(modelTags.classes).filter( (key) => {return modelTags.classes[key] === region.class }),
                                        name:(self.videotagging.frames[frameId].length + 1),
                                        blockSuggest: true
                                        }); 
                                    });
                                    if (Object.keys(self.videotagging.frames).length >= Object.keys(modelTags.frames).length){
                                        resolve();
                                    }
                                }
                            })                       
                        });

                        p.then(()=>{
                            self.videotagging.showAllRegions();
                            //cleanup and notify
                            self.videotagging.video.currentTime = 0;
                            self.videotagging.playingCallback();
                            let notification = new Notification('Offline Video Tagger', { body: 'Model Ready For Review.' });
                            cb();
                        });
                    }, (err) => {
                        cb(err);
                    });
                });
            }

            function saveFrame(frameName, frameId, fCanvas, canvasContext, saveCb){
                var writePath =  path.join(reviewPath, `${frameId}.jpg`);
                //write canvas to file and change frame
                console.log('saving file', writePath);
                fs.exists(writePath, (exists) => {
                    if (!exists) {
                        fs.writeFile(writePath, self.canvasToJpgBuffer(fCanvas, canvasContext), saveCb);
                    }  
                });
            }
        });
    }

    this.reviewEndpoint = function (dir, endpoint, cb) {
        console.log(endpoint);
        if (dir) {
            this.mapDir(detectFrame, dir).then(() => {
                cb();
            },(err) => {
                cb(err);
            });
        } else {
            this.mapVideo(detectFrame, "last").then(() => {
                cb();
            },(err) => {
                cb(err);
            });
        }
        self.videotagging.frames = {};

        function detectFrame(frameName, frameId, fCanvas, canvasContext, detectCb) {
            // extract img from 
            var frame_img =  self.canvasToArrayBuffer(fCanvas, canvasContext, frameId);
            fetch(endpoint, {
                method: 'post', body: frame_img, headers: {
                    contentType: "application/octet-stream"
                }
            }).then(response => response.json()
            ).then((data)=>{
                //dumb way to do this fix with a promis
                self.videotagging.optionalTags.createTagControls(Object.keys(data.classes));
                self.videotagging.frames[frameId] = [];
                data.frames[`${frameId}.jpg`].regions.forEach((region) => {
                    self.videotagging.frames[frameId].push({
                        x1: region.x1,
                        y1: region.y1,
                        x2: region.x2,
                        y2: region.y2,
                        id: self.videotagging.uniqueTagId++,
                        width: fCanvas.width,
                        height: fCanvas.height,
                        type: self.videotagging.regiontype,
                        tags: Object.keys(data.classes).filter((key) => { return data.classes[key] === region.class }),
                        name: (self.videotagging.frames[frameId].length + 1),
                        blockSuggest: true,
                    });
                    self.videotagging.showAllRegions();
                    detectCb();
                });
            }).catch((err)=>{
                detectCb(err);
            }); 
        }
    }

    this.canvasToJpgBuffer = function(canvas, canvasContext) {
        canvasContext.drawImage(videotagging.video, 0, 0);
        var data = canvas.toDataURL('image/jpeg').replace(/^data:image\/\w+;base64,/, ""); // strip off the data: url prefix to get just the base64-encoded bytes http://stackoverflow.com/questions/5867534/how-to-save-canvas-data-to-file
        return new Buffer(data, 'base64');
    }

    this.canvasToArrayBuffer = function(canvas, canvasContext, frameId){
        canvasContext.drawImage(videotagging.video, 0, 0);
        var base64ImageContent = canvas.toDataURL('image/jpeg');
        var blobBin = atob(base64ImageContent.split(',')[1]);
        var array = [];
        for(var i = 0; i < blobBin.length; i++) {
            array.push(blobBin.charCodeAt(i));
        }
        var file =new Blob([new Uint8Array(array)], {type: 'image/png'});
        
        var formdata = new FormData();
        formdata.append("filename", frameId);
        formdata.append("image", file);
        return formdata;        
    }

}

module.exports.Detection = Detection;