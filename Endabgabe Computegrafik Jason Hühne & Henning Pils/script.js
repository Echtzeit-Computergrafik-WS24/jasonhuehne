//=======================================================================================================================================================================================================================================
//Constants
//=======================================================================================================================================================================================================================================

// Light Value
const lightProjection = Mat4.ortho(-20, 20, -20, 20, -10, 20);

// =======================================================================================================================================================================================================================================
// Setup (Control of the Camera), (Skybox), (Light), (Scene and Buffer Size)
// =======================================================================================================================================================================================================================================

let orbitCenter, orbitPan, orbitTilt, orbitDistance, defaultProjection, skybox, sun;
{
    // Interactivity ///////////////////////////////////////////////////////////
    
    orbitCenter = Vec3.all(0);
    orbitCenter.set(0., 2., 0.);
    orbitPan = 1.4;
    orbitTilt = -0.3;
    orbitDistance = 6;
    defaultProjection = Mat4.identity()

    onMouseDrag((e) =>
    {
        orbitPan = glance.clamp(orbitPan - e.movementX * 0.01, -Math.PI, 2 * Math.PI);
        orbitTilt = glance.clamp(orbitTilt - e.movementY * 0.01, -Math.PI / 2, Math.PI / 2);
    });

    onMouseWheel((e) =>
    {
        orbitDistance = glance.clamp(orbitDistance * (1 + e.deltaY * 0.001), 1.0, 25.0);
    });
    onResize(() =>
    {
        defaultProjection.perspective(Math.PI / 3, gl.canvas.width / gl.canvas.height, 0.4, 30);
    });

    skybox = await glance.createSkybox(gl,
        [
            "./Texture/SkyBox/px.png",
            "./Texture/SkyBox/nx.png",
            "./Texture/SkyBox/py.png",
            "./Texture/SkyBox/ny.png",
            "./Texture/SkyBox/pz.png",
            "./Texture/SkyBox/nz.png",
        ],
        { renderNormals: true },
    );
}

// =====================================================================
// ScreenBuffer
// =====================================================================
const screenSize = new glance.Vec2(0.71,0.72)
const screenBufferSize = new glance.Vec2(512,512)

const screenVSSource = `#version 300 es
    precision highp float;

    uniform mat4 u_modelXform;
    uniform mat4 u_viewXform;
    uniform mat4 u_projectionXform;

    in vec3 a_pos;
    in vec2 a_texCoord;

    out vec2 f_texCoord;

    void main() {
        f_texCoord = a_texCoord;
        gl_Position = u_projectionXform * u_viewXform * u_modelXform * vec4(a_pos, 1.0);
    }

`
const screenFSSource = `#version 300 es
    precision mediump float;

    uniform sampler2D u_texture;
    uniform float u_time;

    in vec2 f_texCoord;

    out vec4 o_fragColor;

    void main() {
    vec3 color = texture(u_texture, f_texCoord).rgb;

    o_fragColor = vec4(color, 1.0); 
    }
`
const screenProgram = glance.createProgram(gl, "screen-shader", screenVSSource, screenFSSource)
// =====================================================================
// Shadow Buffer
// =====================================================================

const shadowDepthTexture = glance.createTexture(gl, "shadow-texture", 4000, 4000, {
    internalFormat: gl.DEPTH_COMPONENT16,
    useAnisotropy: false,
    levels: 1,
    filter: gl.NEAREST,
});

const shadowFramebuffer = glance.createFramebuffer(gl, "shadow-framebuffer", null, shadowDepthTexture);

const shadowVSSource = `#version 300 es
    precision highp float;

    uniform mat4 u_modelMatrix;
    uniform mat4 u_lightMatrix;
    uniform mat4 u_lightProjection;

    in vec3 a_pos;

    void main() {
        gl_Position = u_lightProjection * u_lightMatrix * u_modelMatrix * vec4(a_pos, 1.0);
    }
`;

const shadowFSSource = `#version 300 es
    precision mediump float;
    void main() {}
`;

const shadowProgram = glance.createProgram(gl, "shadow-shader", shadowVSSource, shadowFSSource, {
    u_lightProjection: lightProjection,
});

// The size of the scene in the scene.
const sceneSize = new glance.Vec2(4096, 4096);

// The size of the texture displayed on the scene.
const sceneBufferSize = new glance.Vec2(4096, 4096);

// =======================================================================================================================================================================================================================================
// Shader (Vertex and Fragment Shader), (Shader Programm)
// =======================================================================================================================================================================================================================================

// scene Vertex Shader.
const sceneVSSource = `#version 300 es
    precision highp float;

    uniform mat4 u_modelXform;
    uniform mat4 u_viewXform;
    uniform mat4 u_projectionXform;
    uniform vec3 u_viewPosition;
    uniform mat4 u_lightMatrix;
    uniform mat4 u_lightProjection;

    in vec3 a_pos;
    in vec3 a_normal;
    in vec3 a_tangent;
    in vec2 a_texCoord;

    out vec3 f_worldPos;
    out vec3 f_viewPosition;
    out vec2 f_texCoord;
    out mat3 f_tbnXform;
    out vec4 f_posLightSpace;


    void main() {
        vec3 normal = (u_modelXform * vec4(a_normal, 0.0)).xyz;
        vec3 tangent = (u_modelXform * vec4(a_tangent, 0.0)).xyz;
        vec3 bitangent = cross(normal, tangent);
        mat3 tangentXform = transpose(mat3(tangent, bitangent, normal));
        f_tbnXform = mat3(tangent, bitangent, normal);
    
        vec4 worldPosition = u_modelXform * vec4(a_pos, 1.0);
        f_worldPos = worldPosition.xyz;

        f_viewPosition = tangentXform * u_viewPosition;

        f_texCoord = a_texCoord;

        f_posLightSpace = u_lightProjection * u_lightMatrix * worldPosition;
        gl_Position = u_projectionXform * u_viewXform * worldPosition;
    }
`;

// scene Fragment Shader.
const sceneFSSource = `#version 300 es
    precision highp float;

    uniform sampler2D u_texture;
    uniform float u_time;
    uniform float u_ambientIntensity;
    uniform float u_specularPower;
    uniform float u_specularIntensity;
    uniform float u_glossiness;
    uniform vec3 u_viewPosition;
    uniform vec3 u_lightDirection;
    uniform sampler2D u_texDiffuse;
    uniform sampler2D u_texSpecular;
    uniform sampler2D u_texNormal;
    uniform sampler2D u_texGloss;
    uniform sampler2D u_texShadow;
    

    in vec3 f_worldPos;
    in vec3 f_viewPosition;
    in vec2 f_texCoord;
    in mat3 f_tbnXform;
    in vec4 f_posLightSpace;

    out vec4 o_fragColor;

    /// 1 -> full light
    /// 0 -> full shadow
    /// (0 - 1): Penumbra
    float calculateShadow() {
        // Perspective divide.
        vec3 projCoords = f_posLightSpace.xyz / f_posLightSpace.w;

        // Transform from [-1, 1] -> [0, 1]
        projCoords = projCoords * 0.5 + 0.5;

        // No shadow for fragments outside of the shadow volume.
        if(any(lessThan(projCoords, vec3(0))) || any(greaterThan(projCoords, vec3(1)))) {
            return 1.0;
        }

        // Test fragment against depth texture.
        float bias = 0.005;
        float closestDepth = texture(u_texShadow, projCoords.xy).r + bias;
        return projCoords.z > closestDepth  ? 0.0 : 1.0;
    }


    void main() {
        vec3 viewDir = normalize(u_viewPosition - f_worldPos);

        vec3 texDiffuse = texture(u_texDiffuse, f_texCoord).rgb;
        vec3 texSpecular = texture(u_texSpecular, f_texCoord).rgb;
        vec3 texNormal = texture(u_texNormal, f_texCoord).rgb;
        float glossiness = texture(u_texGloss, f_texCoord).r * u_glossiness;

        float effectiveSpecularPower = mix(u_specularPower, u_specularPower * glossiness, glossiness);
        float effectiveSpecularIntensity = u_specularIntensity * glossiness;

        vec3 normal = f_tbnXform * normalize(texNormal * (255.0 / 128.0) - 1.0);
        vec3 lightDir = normalize(u_lightDirection - f_worldPos);
        vec3 halfWay = f_tbnXform * normalize(viewDir + lightDir);

        float diffuseIntensity = u_ambientIntensity + max(dot(normal, lightDir), 0.0) * (1.0 - u_ambientIntensity);
        vec3 diffuse = texDiffuse * diffuseIntensity;

        float specularFactor = pow(max(dot(normal, halfWay), 0.0), effectiveSpecularPower);
        vec3 specular = texSpecular * specularFactor * effectiveSpecularIntensity;

        float shadow = calculateShadow();
    
        o_fragColor = vec4((0.5 + shadow) * (diffuse + specular), 1.0);
    }
`;

// Scene Shader Program.
const sceneProgram = glance.createProgram(gl, "scene-shader", sceneVSSource, sceneFSSource, {
    u_ambientIntensity: 0.04,
    u_specularIntensity: 0.01,
    u_specularPower: 128,
    u_lightProjection: lightProjection,
});

// =======================================================================================================================================================================================================================================
// Scene Geometry (Used by "//VAOS")
// =======================================================================================================================================================================================================================================

const MoonGeo = await glance.loadObj("/Models/moon.obj");
const AstronautGeo = await glance.loadObj("/Models/astro.obj");
const TelevisonGeo = await glance.loadObj("/Models/tv.obj");
const ScreenGeo = await glance.loadObj("/Models/screen.obj")  
const SeatGeo = await glance.loadObj("/Models/seat.obj");
const SatellitGeo = await glance.loadObj("/Models/satellit.obj")

// =======================================================================================================================================================================================================================================
// VAOS (Used by "//Properties")
// =======================================================================================================================================================================================================================================
    // MoonVao
    const MoonVAO = glance.createVertexArrayObject(gl, 'moon-vao',
        MoonGeo.indices,
        {
            a_pos: { data: MoonGeo.positions, height: 3 },
            a_normal: { data: MoonGeo.normals, height: 3 },
            a_texCoord: { data: MoonGeo.texCoords, height: 2 },
            a_tangent: { data: MoonGeo.tangents, height: 3 },
        },
        sceneProgram,
    );
    const AstronautVAO = glance.createVertexArrayObject(gl, 'astro-vao',
        AstronautGeo.indices,
        {
            a_pos: { data: AstronautGeo.positions, height: 3 },
            a_normal: { data: AstronautGeo.normals, height: 3 },
            a_texCoord: { data: AstronautGeo.texCoords, height: 2 },
            a_tangent: { data: AstronautGeo.tangents, height: 3 },
        },
        sceneProgram,
    );
    const TelevisonVAO = glance.createVertexArrayObject(gl, 'tv-vao',
        TelevisonGeo.indices,
        {
            a_pos: { data: TelevisonGeo.positions, height: 3 },
            a_normal: { data: TelevisonGeo.normals, height: 3 },
            a_texCoord: { data: TelevisonGeo.texCoords, height: 2 },
            a_tangent: { data: TelevisonGeo.tangents, height: 3 },
        },
        sceneProgram,
    );
    const ScreenVAO = glance.createVertexArrayObject(gl, 'screen-vao',
        ScreenGeo.indices,
        {
            a_pos: { data: ScreenGeo.positions, height: 3 },
            a_texCoord: { data: ScreenGeo.texCoords, height: 2 },
        },
        screenProgram,
    );
    const SatellitVAO = glance.createVertexArrayObject(gl, 'satellit-vao',
        SatellitGeo.indices,
        {
            a_pos: { data: SatellitGeo.positions, height: 3 },
            a_normal: { data: SatellitGeo.normals, height: 3 },
            a_texCoord: { data: SatellitGeo.texCoords, height: 2 },
            a_tangent: { data: SatellitGeo.tangents, height: 3 },
        },
        sceneProgram,
    );
    const SeatVAO = glance.createVertexArrayObject(gl, 'seat-vao',
        SeatGeo.indices,
        {
            a_pos: { data: SeatGeo.positions, height: 3 },
            a_normal: { data: SeatGeo.normals, height: 3 },
            a_texCoord: { data: SeatGeo.texCoords, height: 2 },
            a_tangent: { data: SeatGeo.tangents, height: 3 },
        },
        sceneProgram,
    );
// =======================================================================================================================================================================================================================================
// Textures
// =======================================================================================================================================================================================================================================
    // Moon
        const moonDiffTexture = await glance.loadTexture(gl, "./Texture/moonDiff.png");
        const moonNormalTexture = await glance.loadTexture(gl, "./Texture/moonNormal.png");
        const moonSpecTexture = await glance.loadTexture(gl, "./Texture/moonSpec.png");
    // Astronaut
        const astroDiffTexture = await glance.loadTexture(gl, "./Texture/astroDiff.png");
        const astroNormalTexture = await glance.loadTexture(gl, "./Texture/astroNormal.png");
    // Television
        const tvDiffTexture = await glance.loadTexture(gl, "./Texture/tvDiff.png");
        const tvNormalTexture = await glance.loadTexture(gl, "./Texture/tvNormal.png");
        const tvSpecTexture = await glance.loadTexture(gl, "./Texture/tvSpec.png");
        const tvGlossTexture = await glance.loadTexture(gl, "./Texture/tvGloss.png");
    // Screen
        const screenTexture = glance.createTexture(gl, "screen-color", screenBufferSize.width, screenBufferSize.height, {
            useAnisotropy : false,
            internalFormat : gl.RGBA8,
            levels: 1,
        })
//        const screenGlossTexture = await glance.loadTexture(gl, "./Texture/tvGloss.png");
    // Satellit
        const satellitDiffTexture = await glance.loadTexture(gl, "./Texture/satellitDiff.png")
    // Seat
        const seatDiffTexture = await glance.loadTexture(gl, "./Texture/seatDiff.png");    
// =======================================================================================================================================================================================================================================
//Properties (Used by "//Render Loop")
// =======================================================================================================================================================================================================================================
    // Moon
    const moon = glance.createDrawCall(gl, "scene", MoonVAO, sceneProgram, {
        textures: { 
            u_texDiffuse: moonDiffTexture,
            u_texNormal: moonNormalTexture,
            u_texShadow: shadowDepthTexture,
        },
                depthTest: gl.LESS,
        cullFace: gl.BACK,
        uniforms: {
            u_modelXform: glance.Mat4.translate(0, -.5, 0).scale(1).rotateY(0),
            u_specularPower: 64,
            u_ambientIntensity: .1, 
            u_specularIntensity: .5,            
         },
    });
    // Astronaut
    const astro = glance.createDrawCall(gl, "scene", AstronautVAO, sceneProgram, {
        textures: { 
            u_texDiffuse: astroDiffTexture,
            u_texNormal: astroNormalTexture,
            u_texShadow: shadowDepthTexture,
        },
        depthTest: gl.LESS,
        cullFace: gl.BACK,
        uniforms: {
            u_modelXform: glance.Mat4.translate(0, -.5, 0).scale(1),
            u_specularPower: 64,
            u_ambientIntensity: 0.1, 
            u_specularIntensity: 0.5,
         },
    });
    // Fernseher
    const tv = glance.createDrawCall(gl, "scene", TelevisonVAO, sceneProgram, {
        textures: { 
            u_texDiffuse: tvDiffTexture,
            u_texNormal: tvNormalTexture,
            u_texSpecular: tvSpecTexture,
            u_texShadow: shadowDepthTexture,
        },
        depthTest: gl.LESS,
        cullFace: gl.BACK,
        uniforms: {
            u_modelXform: glance.Mat4.translate(0, -.5, 0).scale(1),
            u_specularPower: 64,
            u_ambientIntensity: .1, 
            u_specularIntensity: 0.5,  
            u_glossiness: 1.,
         }
    });
    // Screen
    const screen = glance.createDrawCall(gl, "scene", ScreenVAO, screenProgram, {
        textures: { 
            u_texture: screenTexture,
        },
        depthTest: gl.LESS,
        cullFace: gl.BACK,
        uniforms: {
            u_modelXform: glance.Mat4.translate(0, -.5, 0).scale(1),
         },
    });
    //Satellit
    const satellit = glance.createDrawCall(gl, "scene", SatellitVAO, sceneProgram, {
        textures: { 
            u_texDiffuse: satellitDiffTexture,
        },
        depthTest: gl.LESS,
        cullFace: gl.BACK,
        uniforms: {
            u_modelXform: glance.Mat4.translate(0, -0.5, 0).scale(1),
         },
    });
    //Sitz
    const seat = glance.createDrawCall(gl, "scene", SeatVAO, sceneProgram, {
        textures: { 
            u_texDiffuse: seatDiffTexture,

        },
        depthTest: gl.LESS,
        cullFace: gl.BACK,
        uniforms: {
            u_modelXform: glance.Mat4.translate(0, -.5, 0).scale(1),
         },
    });
// =====================================================================
// Shadow Draw Calls
// =====================================================================

const shadowDrawCalls = [
    glance.createDrawCall(gl, "shadow-moon",
        MoonVAO,
        shadowProgram,
        {
            uniforms: {
                u_modelMatrix: glance.Mat4.translate(0, -.5, 0).scale(1),
            },
            cullFace: gl.BACK,
            depthTest: gl.LESS,
        }
    ),
    glance.createDrawCall(gl, "shadow-astro",
        AstronautVAO,
        shadowProgram,
        {
            uniforms: {
                u_modelMatrix: glance.Mat4.translate(0, -.5, 0).scale(1),
            },
            cullFace: gl.BACK,
            depthTest: gl.LESS,
        }
    ),
    glance.createDrawCall(gl, "shadow-tv",
        TelevisonVAO,
        shadowProgram,
        {
            uniforms: {
                u_modelMatrix: glance.Mat4.translate(0, -.5, 0).scale(1),
            },
            cullFace: gl.BACK,
            depthTest: gl.LESS,
        }
    ),
    glance.createDrawCall(gl, "shadow-screen",
        ScreenVAO,
        shadowProgram,
        {
            uniforms: {
                u_modelMatrix: glance.Mat4.translate(0, -.5, 0).scale(1),
            },
            cullFace: gl.BACK,
            depthTest: gl.LESS,
        }
    ),
    glance.createDrawCall(gl, "shadow-seat",
        SeatVAO,
        shadowProgram,
        {
            uniforms: {
                u_modelMatrix: glance.Mat4.translate(0, -.5, 0).scale(1).rotateY(0),
            },
            cullFace: gl.BACK,
            depthTest: gl.LESS,
        }
    ),
]
// =======================================================================================================================================================================================================================================
// screen Buffer
// =======================================================================================================================================================================================================================================
const screenFramebuffer = gl.createFramebuffer();
try {
    gl.bindFramebuffer(gl.FRAMEBUFFER, screenFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, screenTexture.glo, 0)
    const fbStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if(fbStatus !== gl.FRAMEBUFFER_COMPLETE){
        console.log(fbStatus)
        console.log(screenTexture.glo);
        throw new Error("Framebuffer incomplete", fbStatus);
    }
}
finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
}
// =======================================================================================================================================================================================================================================
// scene Buffer
// =======================================================================================================================================================================================================================================

const sceneDepth = gl.createRenderbuffer();
try {
    gl.bindRenderbuffer(gl.RENDERBUFFER, sceneDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, sceneBufferSize.width, sceneBufferSize.height);
} finally {
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
}

const sceneFramebuffer = gl.createFramebuffer();
try {
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFramebuffer);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, sceneDepth);
    
    const fbStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (fbStatus !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error("Framebuffer incomplete");
    }
} finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

// =======================================================================================================================================================================================================================================
// Render Functions
// =======================================================================================================================================================================================================================================

const framebufferStack = new glance.FramebufferStack();
function renderScene(viewPos, viewXform, projectionXform, lightPos, lightXform) {
    for (const drawCall of [moon, astro, tv, screen, seat]) {
        drawCall.uniform.u_viewXform = viewXform;
        drawCall.uniform.u_projectionXform = projectionXform;

        if (drawCall.program !== screenProgram) { 
            drawCall.uniform.u_lightDirection = lightPos;
            drawCall.uniform.u_lightMatrix = lightXform;
        }

        glance.draw(gl, drawCall);
    }
}
function renderFramebuffer(lightPos, lightXform, globalTime)
{
    try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, screenFramebuffer);
        gl.viewport(0, 0, screenBufferSize.width, screenBufferSize.height);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        const viewPos = glance.Vec3.of(3.3, 3.3, 0);
        const viewXform = glance.Mat4.lookAt(viewPos, glance.Vec3.of(0, 0, 0), glance.Vec3.yAxis());
        const projectionXform = glance.Mat4.perspective(Math.PI / 2, 1, 0.1, 20);
        
        renderScene(viewPos, viewXform, projectionXform, lightPos, lightXform);
        skybox.uniform.u_viewXform = viewXform;
        skybox.uniform.u_projectionXform = defaultProjection;
        glance.draw(gl, skybox);
        const curve = 3*Math.sin(globalTime * -0.0001);
        const satellitXform = Mat4.rotateY(globalTime * -0.0001).translateY(curve).translateZ(4);
    satellit.uniform.u_modelXform = satellitXform;
    satellit.uniform.u_viewXform = viewXform;
    satellit.uniform.u_projectionXform = defaultProjection;
        glance.draw(gl, satellit)
        glance.draw(gl, moon)
        glance.draw(gl, astro)
        glance.draw(gl, tv)
        glance.draw(gl, seat)
    }
    finally {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    }
}
// =======================================================================================================================================================================================================================================
// Render Loop
// =======================================================================================================================================================================================================================================


function myRenderLoop({ time, globalTime })
{


    const viewPos = glance.Vec3.translateZ(orbitDistance).rotateX(orbitTilt).rotateY(orbitPan).add(orbitCenter);
    const viewXform = glance.Mat4.lookAt(viewPos, orbitCenter, glance.Vec3.yAxis());

    // Update the light position
    const lightXform = Mat4.rotateX(1 + 0.5 * -orbitTilt).rotateY(1 - 0.5 * -orbitPan).translateY(-7).translateX(0)
    const lightPos = Vec3.of(-0.5, 10, 0);

    renderFramebuffer(lightPos, lightXform);
    const curve = 3*Math.sin(globalTime * -0.0001);
    const satellitXform = Mat4.rotateY(globalTime * -0.0001).translateY(curve).translateZ(4);
    satellit.uniform.u_modelXform = satellitXform;
    satellit.uniform.u_viewXform = viewXform;
    satellit.uniform.u_projectionXform = defaultProjection;
    { // Render the shadow map
        framebufferStack.push(gl, shadowFramebuffer);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        for(const drawCall of shadowDrawCalls) {
            drawCall.uniform.u_lightMatrix = lightXform;
            glance.draw(gl, drawCall);
        }
        framebufferStack.pop(gl);
    }

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    renderScene(viewPos, viewXform, defaultProjection, lightPos, lightXform);
    glance.draw(gl, satellit)

    skybox.uniform.u_viewXform = viewXform;
    skybox.uniform.u_projectionXform = defaultProjection;
    glance.draw(gl, skybox);
}
setRenderLoop(myRenderLoop);