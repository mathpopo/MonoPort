/*global WebSocket, JSON, $, window, console, alert*/
"use strict";
/**
 * Function calls across the background TCP socket. Uses JSON RPC + a queue.
 * (I've added this extra logic to simplify expanding this)
 */

// var cur_tex = document.getElementById("display1").src;



var client = {
  queue: {},
  
  // Connects to Python through the websocket
  connect: function (port) {
    var self = this;
    this.socket = new WebSocket(
      "wss://" + window.location.hostname + ":" + port + "/websocket"
    );

    this.socket.onopen = function () {
      console.log("Connected!");
    };

    this.socket.onmessage = function (messageEvent) {
      var jsonRpc, router, img_norm_str, img_tex_str;

      jsonRpc = JSON.parse(messageEvent.data);
      router = self.queue[jsonRpc.id];
      delete self.queue[jsonRpc.id];
      img_norm_str = "data:image/jpg;base64, " + jsonRpc.img_norm;
      img_tex_str = "data:image/jpg;base64, " + jsonRpc.img_tex;
      // cur_tex = loadImageAndCreateTextureInfo(img_tex_str);
      document.getElementById("display1").setAttribute("src", img_norm_str);
      document.getElementById("display2").setAttribute("src", img_tex_str);
      // document.getElementById('viewport').setAttribute("style", `background: ${img_tex_str}`);
    };
  },


  // Generates a unique identifier for request ids
  // Code from http://stackoverflow.com/questions/105034/
  // how-to-create-a-guid-uuid-in-javascript/2117523#2117523
  uuid: function () {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (
      c
    ) {
      var r = (Math.random() * 16) | 0,
        v = c == "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  },

  // Placeholder function. It adds one to things.
  updateMatrix: function (name, data) {
    var uuid = this.uuid();
    this.socket.send(
      JSON.stringify({
        method: "matrix",
        id: uuid,
        name: name,
        data: data,
      })
    );
    this.queue[uuid] = "matrix";
  },
};

// Options that can be configured to alter behavior of the sample
// These are constants but in theory could be changed to variables
// to allow uture UI additions to change them in-flight.

const allowMouseRotation = true;
const allowKeyboardMotion = true;
const enableForcePolyfill = false;
const SESSION_TYPE = "immersive-ar";       // "immersive-ar" or "inline"
// const SESSION_TYPE = "inline";
const MOUSE_SPEED = 0.003;
const MOVE_DISTANCE = 0.4;

// WebXR variables

let polyfill = null;
let xrSession = null;
let xrInputSources = null;
let xrReferenceSpace = null;
let xrButton = null;
let gl = null;
let objdata = { verts: [], faces: [], normals: [], texcoords: [] };
let animationFrameRequestID = 0;
let bg_animationFrameRequestID = 0;

// fetch data.json for grass environment
fetch("static/grass/data.json")
  .then((response) => {
    console.log(response);
    return response.json();
  })
  .then((data) => {
    objdata = JSON.parse(JSON.stringify(data));
    // Work with JSON data here
    console.log(data);
  })
  .catch((err) => {
    // Do something for an error here
    console.log("Error Reading data " + err);
  });

// Renderer variables and constants

const viewerStartPosition = vec3.fromValues(0, -0.4, -1.0);
const viewerStartOrientation = vec3.fromValues(0, 0, 1.0);

const upVector = vec3.fromValues(0, 1, 0);
const cubeOrientation = vec3.create();
const cubeMatrix = mat4.create();
const mouseMatrix = mat4.create();

// Conversion constants

const RADIANS_PER_DEGREE = Math.PI / 180.0;

// Vectors used for creating "orthonormal up"; that is,
// the vector pointing straight out of the top of the
// object, even if it's rotated.

const vecX = vec3.create();
const vecY = vec3.create();

// For storing references to the elements into which matrices
// are to be output

let projectionMatrixOut;
let modelMatrixOut;
let cameraMatrixOut;
let normalMatrixOut;
let mouseMatrixOut;

// Log a WebGL error message. The where parameter should be
// a string identifying the circumstance of the error.

function LogGLError(where) {
  let err = gl.getError();
  if (err) {
    console.error(`WebGL error returned by ${where}: ${err}`);
  }
}

//
// Shaders from the original cube demo
//

// Vertex shader program

const vsSource = `
  attribute vec4 aVertexPosition;
  attribute vec3 aVertexNormal;
  attribute vec2 aTextureCoord;

  uniform mat4 uNormalMatrix;
  uniform mat4 uModelViewMatrix;
  uniform mat4 uProjectionMatrix;

  varying highp vec2 vTextureCoord;
  varying highp vec3 vLighting;

  void main(void) {
    gl_Position = uProjectionMatrix * uModelViewMatrix * aVertexPosition;
    vTextureCoord = aTextureCoord;

    // Apply lighting effect

    highp vec3 ambientLight = vec3(1.0, 1.0, 1.0);
    highp vec3 directionalLightColor = vec3(1, 1, 1);
    highp vec3 lightingVector = normalize(vec3(0.85, 0.8, 0.75));

    highp vec4 transformedNormal = uNormalMatrix * vec4(aVertexNormal, 1.0);

    highp float directional = max(dot(transformedNormal.xyz, lightingVector), 0.0);
    vLighting = ambientLight + (directionalLightColor * directional);
    // vLighting = ambientLight;
  }
`;

// Fragment shader program

const fsSource = `
  varying highp vec2 vTextureCoord;
  varying highp vec3 vLighting;

  uniform sampler2D uSampler;

  void main(void) {
    highp vec4 texelColor = texture2D(uSampler, vTextureCoord);

    gl_FragColor = vec4(texelColor.rgb * vLighting, texelColor.a);
  }
`;

const vsSource_bg = `
  attribute vec4 a_position;
  attribute vec2 a_texcoord;

  uniform mat4 u_matrix;

  varying vec2 v_texcoord;

  void main() {
      gl_Position = u_matrix * a_position;
      v_texcoord = a_texcoord;
  }
`;

const fsSource_bg = `
  precision mediump float;
              
  varying vec2 v_texcoord;
  
  uniform sampler2D u_texture;
  
  void main() {
      gl_FragColor = texture2D(u_texture, v_texcoord);
  }
`;

window.addEventListener("load", onLoad);

function onLoad() {
  xrButton = document.querySelector("#enter-xr");
  xrButton.addEventListener("click", onXRButtonClick);

  // Get the matrix output elements

  projectionMatrixOut = document.querySelector("#projection-matrix div");
  modelMatrixOut = document.querySelector("#model-view-matrix div");
  cameraMatrixOut = document.querySelector("#camera-matrix div");
  normalMatrixOut = document.querySelector("#normal-matrix div");
  mouseMatrixOut = document.querySelector("#mouse-matrix div");

  // Install the WebXR polyfill if needed or if the
  // enableForcePolyfill option is set to true

  if (!navigator.xr || enableForcePolyfill) {
    console.log("Using the polyfill");
    polyfill = new WebXRPolyfill();
  }
  setupXRButton();
}

function setupXRButton() {
  if (navigator.xr.isSessionSupported) {
    navigator.xr.isSessionSupported(SESSION_TYPE).then((supported) => {
      xrButton.disabled = !supported;
    });
  } else {
    navigator.xr
      .supportsSession(SESSION_TYPE)
      .then(() => {
        xrButton.disabled = false;
      })
      .catch(() => {
        xrButton.disabled = true;
      });
  }
}

async function onXRButtonClick(event) {
  if (!xrSession) {
    navigator.xr.requestSession(SESSION_TYPE).then(sessionStarted);
  } else {
    await xrSession.end();

    // If the end event didn't cause us to close things down,
    // do it explicitly here, now that the promise returned by
    // end() has been resolved.

    if (xrSession) {
      sessionEnded();
    }
  }
}

// Variables for storing the details about the GLSL program and the
// data it needs.

let shaderProgram = null;
let programInfo = null;
let buffers = null;
let texture = null;

let shaderProgram_bg = null;
let programInfo_bg = null;
let buffers_bg = null;
let texture_bg = null;

function sessionStarted(session) {
  let refSpaceType;

  xrSession = session;
  xrButton.innerText = "Exit WebXR";

  // Listen for the "end" event; when it arrives, we will
  // halt any animations and the like.

  xrSession.addEventListener("end", sessionEnded);

  // Set up the rendering context for use with the display we're
  // using. Here, we're using a context that's actually
  // visible in the document, in order to see what's going
  // on even without a headset. Normally you would use
  // document.createElement("canvas") to create an offscreen
  // canvas.

  let canvas = document.querySelector("canvas");
  gl = canvas.getContext("webgl", { xrCompatible: true });

  // If we have mouse rotation support enabled, add it here.

  if (allowMouseRotation) {
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("contextmenu", (event) => {
      event.preventDefault();
    });
  }

  // If keyboard movement is enabled, add it

  if (allowKeyboardMotion) {
    document.addEventListener("keydown", handleKeyDown);
  }

  // Initialize a shader program; this is where all the lighting
  // for the vertices and so forth is established.
  shaderProgram = initShaderProgram(gl, vsSource, fsSource);
  shaderProgram_bg = initShaderProgram(gl, vsSource_bg, fsSource_bg);

  programInfo_bg = {
    program: shaderProgram_bg,
    // look up where the vertex data needs to go.
    positionLocation: gl.getAttribLocation(shaderProgram_bg, "a_position"),
    texcoordLocation: gl.getAttribLocation(shaderProgram_bg, "a_texcoord"),

    // lookup uniforms
    matrixLocation: gl.getUniformLocation(shaderProgram_bg, "u_matrix"),
    textureLocation: gl.getUniformLocation(shaderProgram_bg, "u_texture"),
  };

  buffers_bg = initBuffers_bg(gl);

  // Collect all the info needed to use the shader program.
  // Look up which attributes our shader program is using
  // for aVertexPosition, aVertexNormal, aTextureCoord,
  // and look up uniform locations.
  programInfo = {
    program: shaderProgram,
    attribLocations: {
      vertexPosition: gl.getAttribLocation(shaderProgram, "aVertexPosition"),
      vertexNormal: gl.getAttribLocation(shaderProgram, "aVertexNormal"),
      textureCoord: gl.getAttribLocation(shaderProgram, "aTextureCoord"),
    },
    uniformLocations: {
      projectionMatrix: gl.getUniformLocation(
        shaderProgram,
        "uProjectionMatrix"
      ),
      modelViewMatrix: gl.getUniformLocation(shaderProgram, "uModelViewMatrix"),
      normalMatrix: gl.getUniformLocation(shaderProgram, "uNormalMatrix"),
      uSampler: gl.getUniformLocation(shaderProgram, "uSampler"),
    },
  };

  buffers = initBuffers(gl);

  texture = loadTexture(
    gl,
    "static/grass/10438_Circular_Grass_Patch_v1_Diffuse.jpg"
  );

  // Create the XRWebGLLayer to use as the base layer for the
  // session.

  xrSession.updateRenderState({
    baseLayer: new XRWebGLLayer(xrSession, gl)
  });

  // Get the reference space for querying poses.

  if (SESSION_TYPE == "immersive-ar") {
    refSpaceType = "local";
  } else {
    refSpaceType = "viewer";
  }

  // Set up the initial matrix for the cube's position
  // and orientation.

  mat4.fromTranslation(cubeMatrix, viewerStartPosition);

  // Initialize the cube's current orientation relative to the
  // global space.

  vec3.copy(cubeOrientation, viewerStartOrientation);

  // Set vecY to point straight up copying the upVector
  // into it. vecY will always point outward from the top
  // of the object, regardless of changes made to yaw and
  // pitch by the user.

  vec3.copy(vecY, upVector);

  xrSession.requestReferenceSpace(refSpaceType).then((refSpace) => {
    xrReferenceSpace = refSpace;
    xrReferenceSpace = xrReferenceSpace.getOffsetReferenceSpace(
      new XRRigidTransform(viewerStartPosition, cubeOrientation)
    );
    animationFrameRequestID = xrSession.requestAnimationFrame(drawFrame);
    // bg_animationFrameRequestID = xrSession.requestAnimationFrame(renderBackground);
  });

  return xrSession;
}

function sessionEnded() {
  xrButton.innerText = "Enter WebXR";

  // If we have a pending animation request, cancel it; this
  // will stop processing the animation of the scene.

  if (animationFrameRequestID) {
    xrSession.cancelAnimationFrame(animationFrameRequestID);
    animationFrameRequestID = 0;
  }

  // if (bg_animationFrameRequestID) {
  //   xrSession.cancelAnimationFrame(bg_animationFrameRequestID);
  //   bg_animationFrameRequestID = 0;
  // }

  xrSession = null;
}

// Variables used to handle rotation using the mouse

let mouseYaw = 0;
let mousePitch = 0;
const inverseOrientation = quat.create();

// Variables for handling keyboard movement

let axialDistance = 0;
let transverseDistance = 0;
let verticalDistance = 0;

// Handle keyboard events; for the WASD keys,
// apply movement forward/backward or side-to-side.
// The "R" key resets the position and orientation
// to the starting point.

function handleKeyDown(event) {
  switch (event.key) {
    // Forward
    case "w":
    case "W":
      verticalDistance -= MOVE_DISTANCE;
      break;
    // Backward
    case "s":
    case "S":
      verticalDistance += MOVE_DISTANCE;
      break;
    // Left
    case "a":
    case "A":
      transverseDistance += MOVE_DISTANCE;
      break;
    // Right
    case "d":
    case "D":
      transverseDistance -= MOVE_DISTANCE;
      break;
    case "ArrowUp":
      axialDistance += MOVE_DISTANCE;
      break;
    case "ArrowDown":
      axialDistance -= MOVE_DISTANCE;
      break;
    // Reset
    case "r":
    case "R":
      transverseDistance = axialDistance = verticalDistance = 0;
      mouseYaw = mousePitch = 0;
      break;
    default:
      break;
  }
}

// Handle the pointermove event; called only if rotation
// using the mouse is enabled. The right mouse button
// must also be down.

function handlePointerMove(event) {
  if (event.buttons & 2) {
    rotateViewBy(event.movementX, event.movementY);
  }
}

// Rotate the view by the specified deltas. Used for
// things like mouse/keyboard/touch controls.

function rotateViewBy(dx, dy) {
  mouseYaw -= dx * MOUSE_SPEED;
  mousePitch -= dy * MOUSE_SPEED;

  if (mousePitch < -Math.PI * 0.5) {
    mousePitch = -Math.PI * 0.5;
  } else if (mousePitch > Math.PI * 0.5) {
    mousePitch = Math.PI * 0.5;
  }
}

let lastFrameTime = 0;

function initBuffers_bg(gl) {
  // Create a buffer.
  var positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);

  // Put a unit quad in the buffer
  var positions = [0, 0, 0, 1, 1, 0, 1, 0, 0, 1, 1, 1];
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);

  // Create a buffer for texture coords
  var texcoordBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, texcoordBuffer);

  // Put texcoords in the buffer
  var texcoords = [0, 0, 0, 1, 1, 0, 1, 0, 0, 1, 1, 1];
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(texcoords), gl.STATIC_DRAW);

  return {
    position: positionBuffer,
    texcoord: texcoordBuffer,
  };
}

function loadImageAndCreateTextureInfo(url) {

  var tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  // Fill the texture with a 1x1 blue pixel.
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([0, 0, 255, 255])
  );

  // let's assume all images are not a power of 2
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

  var textureInfo = {
    width: 1, // we don't know the size until it loads
    height: 1,
    texture: tex,
  };
  var img = new Image();
  img.addEventListener("load", function () {
    textureInfo.width = img.width;
    textureInfo.height = img.height;

    gl.bindTexture(gl.TEXTURE_2D, textureInfo.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  });
  img.src = url;

  return textureInfo;
}

function drawImage(tex, texWidth, texHeight, dstX, dstY) {

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  gl.bindTexture(gl.TEXTURE_2D, tex);

  // Tell WebGL to use our shader program pair
  gl.useProgram(programInfo_bg.program);

  // Setup the attributes to pull data from our buffers
  gl.bindBuffer(gl.ARRAY_BUFFER, buffers_bg.position);

  gl.enableVertexAttribArray(programInfo_bg.positionLocation);
  gl.vertexAttribPointer(
    programInfo_bg.positionLocation,
    2,
    gl.FLOAT,
    false,
    0,
    0
  );

  gl.bindBuffer(gl.ARRAY_BUFFER, buffers_bg.texcoord);
  gl.enableVertexAttribArray(programInfo_bg.texcoordLocation);
  gl.vertexAttribPointer(
    programInfo_bg.texcoordLocation,
    2,
    gl.FLOAT,
    false,
    0,
    0
  );

  // this matrix will convert from pixels to clip space
  var matrix = m4.orthographic(0, gl.canvas.width, gl.canvas.height, 0, -1, 1);

  // this matrix will translate our quad to dstX, dstY
  matrix = m4.translate(matrix, dstX, dstY, 0);

  // this matrix will scale our 1 unit quad
  // from 1 unit to texWidth, texHeight units
  matrix = m4.scale(matrix, texWidth, texHeight, 1);

  // Set the matrix.
  gl.uniformMatrix4fv(programInfo_bg.matrixLocation, false, matrix);

  // Tell the shader to get the texture from texture unit 0
  gl.uniform1i(programInfo_bg.textureLocation, 0);

  // draw the quad (2 triangles, 6 vertices)
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function renderBackground() {
  

  webglUtils.resizeCanvasToDisplaySize(gl.canvas);
  gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

  gl.clear(gl.COLOR_BUFFER_BIT);

  let cur_tex = loadImageAndCreateTextureInfo(
    document.getElementById("display1").src);

  drawImage(
      cur_tex.texture,
      cur_tex.width,
      cur_tex.height,
      0.0,
      0.0
  );

  window.requestAnimationFrame(renderBackground);

}

window.requestAnimationFrame(renderBackground);

function drawFrame(time, frame) {
  // Adjust for any mouse-based movement of the viewer

  let adjustedRefSpace = applyViewerControls(xrReferenceSpace);

  // Get the pose relative to the reference space

  let pose = frame.getViewerPose(adjustedRefSpace);

  // Let the session know to go ahead and plan to hit us up
  // again next frame

  animationFrameRequestID = frame.session.requestAnimationFrame(drawFrame);

  // Make sure we have a pose and start rendering

  if (pose) {
  
    let glLayer = frame.session.renderState.baseLayer;

    // Bind the WebGL layer's framebuffer to the renderer

    gl.bindFramebuffer(gl.FRAMEBUFFER, glLayer.framebuffer);
    LogGLError("bindFrameBuffer");

    // Clear the GL context in preparation to render the
    // new frame

    gl.clearColor(1, 1, 1, 1.0);
    gl.clearDepth(1.0); // Clear everything
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    LogGLError("glClear");

    let viewport = glLayer.getViewport(pose.views[0]);
    gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
    LogGLError(`Setting viewport for eye: ${pose.views[0].eye}`);
    gl.canvas.width = viewport.width;
    gl.canvas.height = viewport.height;
    renderScene(gl, pose.views[0], programInfo, buffers, texture);
    // window.requestAnimationFrame(renderBackground);

 
  }
}


// Create a new reference space that includes the effect
// of the rotiation indicated by mousePitch and mouseYaw.
// Include also the keyboard motion information if
// available.

function applyViewerControls(refSpace) {
  if (
    !mouseYaw &&
    !mousePitch &&
    !axialDistance &&
    !transverseDistance &&
    !verticalDistance
  ) {
    return refSpace;
  }

  // Compute the quaternion used to rotate the viewpoint based
  // on the pitch and yaw.

  quat.identity(inverseOrientation);
  quat.rotateX(inverseOrientation, inverseOrientation, -mousePitch);
  quat.rotateY(inverseOrientation, inverseOrientation, -mouseYaw);

  // Compute the true "up" vector for our object.

  // vec3.cross(vecX, vecY, cubeOrientation);
  // vec3.cross(vecY, cubeOrientation, vecX);

  // Now compute the transform that teleports the object to the
  // specified point and save a copy of it to display to the user
  // later; otherwise we probably wouldn't need to save mouseMatrix
  // at all.

  let newTransform = new XRRigidTransform(
    { x: transverseDistance, y: verticalDistance, z: axialDistance },
    {
      x: inverseOrientation[0],
      y: inverseOrientation[1],
      z: inverseOrientation[2],
      w: inverseOrientation[3],
    }
  );
  mat4.copy(mouseMatrix, newTransform.matrix);

  // Create a new reference space that transforms the object to the new
  // position and orientation, returning the new reference space.

  return refSpace.getOffsetReferenceSpace(newTransform);
}

// Storage for values used by renderScene(), declared
// globally so they aren't being reallocated every
// frame. Could also be in an object if renderScene()
// were a method on an object.

const normalMatrix = mat4.create();
const modelViewMatrix = mat4.create();

//
// Render the scene.
//
function renderScene(gl, view, programInfo, buffers, texture) {
  gl.enable(gl.DEPTH_TEST); // Enable depth testing
  gl.depthFunc(gl.LEQUAL); // Near things obscure far things

  // Model view matrix is view.transform.inverse.matrix * cubeMatrix; this
  // moves the object in relation to the viewer in order to simulate the movement
  // of the viewer.

  mat4.multiply(modelViewMatrix, view.transform.inverse.matrix, cubeMatrix);

  // Compute the normal matrix for the view

  mat4.invert(normalMatrix, modelViewMatrix);
  mat4.transpose(normalMatrix, normalMatrix);

  // Display the matrices to the screen for review and because MathML
  // is a nifty underused technology.

  displayMatrix(view.projectionMatrix, 4, projectionMatrixOut);
  displayMatrix(modelViewMatrix, 4, modelMatrixOut);
  displayMatrix(view.transform.matrix, 4, cameraMatrixOut);
  displayMatrix(normalMatrix, 4, normalMatrixOut);
  displayMatrix(mouseMatrix, 4, mouseMatrixOut);

  client.updateMatrix("projection", view.projectionMatrix);
  client.updateMatrix("modelview", modelViewMatrix);
  client.updateMatrix("transform", view.transform.matrix);
  client.updateMatrix("normal", normalMatrix);
  client.updateMatrix("mouse", mouseMatrix);

  // Tell WebGL how to pull out the positions from the position
  // buffer into the vertexPosition attribute
  {
    const numComponents = 3;
    const type = gl.FLOAT;
    const normalize = false;
    const stride = 0;
    const offset = 0;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.position);
    gl.vertexAttribPointer(
      programInfo.attribLocations.vertexPosition,
      numComponents,
      type,
      normalize,
      stride,
      offset
    );
    gl.enableVertexAttribArray(programInfo.attribLocations.vertexPosition);
  }

  // Tell WebGL how to pull out the texture coordinates from
  // the texture coordinate buffer into the textureCoord attribute.
  {
    const numComponents = 2;
    const type = gl.FLOAT;
    const normalize = false;
    const stride = 0;
    const offset = 0;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.textureCoord);
    gl.vertexAttribPointer(
      programInfo.attribLocations.textureCoord,
      numComponents,
      type,
      normalize,
      stride,
      offset
    );
    gl.enableVertexAttribArray(programInfo.attribLocations.textureCoord);
  }

  // Tell WebGL how to pull out the normals from
  // the normal buffer into the vertexNormal attribute.
  {
    const numComponents = 3;
    const type = gl.FLOAT;
    const normalize = false;
    const stride = 0;
    const offset = 0;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.normal);
    gl.vertexAttribPointer(
      programInfo.attribLocations.vertexNormal,
      numComponents,
      type,
      normalize,
      stride,
      offset
    );
    gl.enableVertexAttribArray(programInfo.attribLocations.vertexNormal);
  }

  // Give WebGL the list of index numbers identifying
  // the order in which to connect the vertices to
  // render the triangle set that makes up our object.
  // Every group of three entries in this list are
  // used as indices into the vertex buffer to get
  // the coordinates that make up each triangle in the
  // batch of triangles.
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers.indices);

  // Tell WebGL to use our program when drawing these
  // triangles. The program includes the vertex and
  // fragment shaders that will define the final position
  // of each vertex and the color of each pixel within
  // the rendered triangles.
  gl.useProgram(programInfo.program);

  // Send our computed matrices to the GPU by setting the
  // values of the corresponding uniforms.
  gl.uniformMatrix4fv(
    programInfo.uniformLocations.projectionMatrix,
    false,
    view.projectionMatrix
  );
  gl.uniformMatrix4fv(
    programInfo.uniformLocations.modelViewMatrix,
    false,
    modelViewMatrix
  );
  gl.uniformMatrix4fv(
    programInfo.uniformLocations.normalMatrix,
    false,
    normalMatrix
  );

  // Specify the texture to map onto the faces. We're
  // only using one texture, in texture unit 0; we first
  // select TEXTURE0, then bind the texture to it. If
  // we were using more textures, we'd bind them to
  // other texture numbers in the same way.
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);

  // Pass the texture number, 0, to the shader program
  // so it knows which one to use.
  gl.uniform1i(programInfo.uniformLocations.uSampler, 0);

  // Render all of the triangles in the list that makes
  // up the object.
  {
    const vertexCount = 32256;
    const type = gl.UNSIGNED_SHORT;
    const offset = 0;
    gl.drawElements(gl.TRIANGLES, vertexCount, type, offset);
  }
}

// Replace the contents of the specified block with a
// MathML-rendered matrix, because MathML is nifty!

function displayMatrix(mat, rowLength, target) {
  let outHTML = "";

  if (mat && rowLength && rowLength <= mat.length) {
    let numRows = mat.length / rowLength;
    outHTML =
      "<math xmlns='http://www.w3.org/1998/Math/MathML' display='block'>\n<mrow>\n<mo>[</mo>\n<mtable>\n";

    for (let y = 0; y < numRows; y++) {
      outHTML += "<mtr>\n";
      for (let x = 0; x < rowLength; x++) {
        outHTML += `<mtd><mn>${mat[x * rowLength + y].toFixed(2)}</mn></mtd>\n`;
      }
      outHTML += "</mtr>\n";
    }

    outHTML += "</mtable>\n<mo>]</mo>\n</mrow>\n</math>";
  }

  target.innerHTML = outHTML;
}

//
// Initialize a shader program, so WebGL knows how to draw our data
//
function initShaderProgram(gl, vsSource, fsSource) {
  const vertexShader = loadShader(gl, gl.VERTEX_SHADER, vsSource);
  const fragmentShader = loadShader(gl, gl.FRAGMENT_SHADER, fsSource);

  // Create the shader program

  const shaderProgram = gl.createProgram();
  LogGLError("createProgram");
  gl.attachShader(shaderProgram, vertexShader);
  LogGLError("attachShader (vertex)");
  gl.attachShader(shaderProgram, fragmentShader);
  LogGLError("attachShader (fragment)");

  gl.linkProgram(shaderProgram);
  LogGLError("linkProgram");

  // If creating the shader program failed, alert

  if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
    alert(
      "Unable to initialize the shader program: " +
        gl.getProgramInfoLog(shaderProgram)
    );
    return null;
  }

  return shaderProgram;
}

//
// creates a shader of the given type, uploads the source and
// compiles it.
//
function loadShader(gl, type, source) {
  const shader = gl.createShader(type);
  LogGLError("createShader");

  // Send the source to the shader object

  gl.shaderSource(shader, source);
  LogGLError("shaderSource");

  // Compile the shader program

  gl.compileShader(shader);
  LogGLError("compileShader");

  // See if it compiled successfully

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    alert(
      "An error occurred compiling the shaders: " + gl.getShaderInfoLog(shader)
    );
    gl.deleteShader(shader);
    return null;
  }

  return shader;
}

// Initialize the buffers we'll need. For this demo, we just
// have one object -- a simple three-dimensional cube.
//
function initBuffers(gl) {
  // Create a buffer for the cube's vertex positions.

  const positionBuffer = gl.createBuffer();
  LogGLError("createBuffer (positionBuffer)");

  // Select the positionBuffer as the one to apply buffer
  // operations to from here out.

  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  LogGLError("bindBuffer (positionBuffer)");

  // Now create an array of coordinates for each vertex in the
  // cube. These will be referenced by index into the list
  // in order to define the positions of the cube's vertices
  // in object-local space.

  const positions = objdata.verts;

  // Now pass the list of positions into WebGL to build the
  // shape. We do this by creating a Float32Array from the
  // JavaScript array, then use it to fill the current buffer.

  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
  LogGLError("bufferData (positions)");

  // Set up the normals for the vertices, so that we can compute lighting.

  const normalBuffer = gl.createBuffer();
  LogGLError("createBuffer (vertex normals: normalBuffer)");
  gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
  LogGLError("bindBuffer (vertex normals: normalBuffer)");

  const vertexNormals = objdata.normals;

  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array(vertexNormals),
    gl.STATIC_DRAW
  );
  LogGLError("bufferData (vertexNormals)");

  // Now set up the texture coordinates for the faces.

  const textureCoordBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, textureCoordBuffer);
  LogGLError("bindBuffer (textureCoordBuffer)");

  const textureCoordinates = objdata.texcoords;

  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array(textureCoordinates),
    gl.STATIC_DRAW
  );
  LogGLError("bufferData (textureCoordinates)");

  // Build the element array buffer; this specifies the indices
  // into the vertex arrays for each face's vertices.

  const indexBuffer = gl.createBuffer();
  LogGLError("createBuffer (indexBuffer)");
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  LogGLError("bindBuffer (indexBuffer)");

  // This array defines each face as two triangles, using the
  // indices into the vertex array to specify each triangle's
  // position.

  const indices = objdata.faces;

  // Now send the element array to GL

  gl.bufferData(
    gl.ELEMENT_ARRAY_BUFFER,
    new Uint16Array(indices),
    gl.STATIC_DRAW
  );
  LogGLError("bufferData (indices)");

  return {
    position: positionBuffer,
    normal: normalBuffer,
    textureCoord: textureCoordBuffer,
    indices: indexBuffer,
  };
}

//
// Initialize a texture and load an image.
// When the image finished loading copy it into the texture.
//
function loadTexture(gl, url) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);

  // Because images have to be download over the internet
  // they might take a moment until they are ready.
  // Until then put a single pixel in the texture so we can
  // use it immediately. When the image has finished downloading
  // we'll update the texture with the contents of the image.
  const level = 0;
  const internalFormat = gl.RGBA;
  const width = 1;
  const height = 1;
  const border = 0;
  const srcFormat = gl.RGBA;
  const srcType = gl.UNSIGNED_BYTE;
  const pixel = new Uint8Array([100, 100, 255, 255]); // opaque blue
  gl.texImage2D(
    gl.TEXTURE_2D,
    level,
    internalFormat,
    width,
    height,
    border,
    srcFormat,
    srcType,
    pixel
  );
  LogGLError("texImage2D");

  const image = new Image();
  image.crossOrigin = "anonymous";
  image.onload = function () {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      level,
      internalFormat,
      srcFormat,
      srcType,
      image
    );

    // WebGL1 has different requirements for power of 2 images
    // vs non power of 2 images so check if the image is a
    // power of 2 in both dimensions.
    if (isPowerOf2(image.width) && isPowerOf2(image.height)) {
      // Yes, it's a power of 2. Generate mips.
      gl.generateMipmap(gl.TEXTURE_2D);
    } else {
      // No, it's not a power of 2. Turn off mips and set
      // wrapping to clamp to edge
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
  };
  image.onerror = function (e) {
    console.error(`Error loading image`);
  };

  image.src = url;

  return texture;
}

function isPowerOf2(value) {
  return (value & (value - 1)) == 0;
}
