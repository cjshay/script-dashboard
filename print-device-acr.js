
require('json5/lib/require');

var $_program       = require('commander'),
    $_promise       = require('bluebird'),
    $               = require('shelljs'),
    $_requestify    = require('requestify'),
    $_table         = require('cli-table'),
    $_loge          = require('utils/loge'),
    $log            = $_loge.getLogger('tstdev'),
    $provservers    = [ 'prov', 'prov1', 'prov2', 'prov3' ];

$_loge.setGlobalLevel('WARN');
$.config.silent = true;

process.on
(
    'exit',
    function(code)
    {
        if( code === 0 )
            console.log("Hooray! We are all done!");
        else
            console.log("Oops! Bad stuff has happened.");
        process.exit(code);
    }
);

get_options();
run();

//------------------------------------------------------------------------------
function get_options()
{
    $_program
        .option('--device <deviceid>', 'Device ID for testing')
        .option('--loglevel <level>', 'Set loglevel', 'INFO')
        .parse(process.argv);

    if( ! $_program.device )
    {
        $log.error("Need a device id to check. Please use --device option.");
        process.exit(1);
    }

    $log.setLevel($_program.loglevel);
}

//------------------------------------------------------------------------------
function run()
{
    var device_id   = $_program.device,
        acrserver   = null,
        i;

    for( i = 0; acrserver === null && i < $provservers.length; i++ )
        acrserver = find_acr_server($provservers[i], device_id);

    if( ! acrserver )
    {
        $log.error(`Could not find ACR server for device ${device_id}.`);
        process.exit(1);
    }

    if( ! ping(acrserver.server) )
    {
        $log.error(`Ping to ACR server ${acrserver.server} failed.`);
        process.exit(1);
    }

    var sessions = print_session_info(acrserver, device_id);
    print_cv_info(device_id, sessions);
}

//------------------------------------------------------------------------------
function find_acr_server(provserver, device_id)
{
    $log.debug(`Checking prov server ${provserver} for device ${device_id}...`);

    var out = $.exec(`ssh -q alpha@${provserver}.alphonso.tv show_servers_status | \
                        grep -B2000 ${device_id} | grep acr | tail -1`);
    var matches;
    if( matches = /alphonsoalph([^_]+)_alphonso_tv(\d+)/.exec(out.stdout))
    {
        let [ line, acrserver, port ] = matches;
        $log.info(`Device on ${provserver} assigned to ACR server: ${acrserver}, port: ${port}.`);
        if( provserver === 'prov' )
            $log.info($.exec("host prov.alphonso.tv | head -1").stdout.trim());
        return({ server : acrserver, port : port });
    }
    else
        return(null);
}

//------------------------------------------------------------------------------
function ping(server)
{
    $log.debug(`Pinging ACR server ${server}...`);
    var out = $.exec(`ping -i 0.2 -c 10 -s 2048 ${server}.alphonso.tv`, { silent : false });
    if( out.code === 0 )
    {
        $log.info(`ACR server ${server} is alive and reachable.`);
        return(true);
    }
    else
        return(false);
}

//------------------------------------------------------------------------------
function print_session_info(acrserver, device_id)
{
    let { server, port } = acrserver;

    $log.debug(`Getting info for device ${device_id} from ACR server ${server}...`);
    $log.debug('Getting log file...');
    var out = $.exec(`ssh alpha@${server}.alphonso.tv \
                        grep ${device_id} /mnt/alpha/var/log/pm2/acr-${port}.out`);
    $log.debug('Parsing log file, size =', out.stdout.length, '...');
    var sessions = { }, session_ids = [ ];
    out.stdout.split('\n').forEach
    (
        line =>
        {
            var session_id, matches;

            if( matches = /^\[([^\]]+)\].*session id ([^,]+), .* type = start/.exec(line) )
            {
                session_id = matches[2];
                $log.debug(`Got new session start message with session id: ${session_id}`);
                sessions[session_id] =
                {
                    start_time  : matches[1],
                    end_time    : '',
                    tag         : '',
                    station_id  : '',
                    content_id  : ''
                };
                if( session_ids.length === 10 )
                    session_ids.shift();
                session_ids.push(session_id);
                return;
            }

            if( matches = /^\[([^\]]+)\].*session id ([^,]+), .* type = end/.exec(line) )
            {
                session_id = matches[2];
                $log.debug(`Got new session end message with session id: ${session_id}`);
                if( sessions[session_id] )
                    sessions[session_id].end_time = matches[1];
                else
                    $log.debug('Ignoring since start was not in log.');
                return;
            }

            if( matches = /.*Got match.*token (\S+)-[cl]-.*tag = (\S*).*content id = (\d*).*station id = (\d*)/.exec(line) )
            {
                $log.debug("Got match for:", matches[1], "cid:", matches[3], "sid:", matches[4]);

                let s = sessions[matches[1]];

                if( ! s )
                {
                    $log.debug('Ignoring since start was not in log.');
                    return;
                }

                s.tag           = matches[4] ? matches[2] : '';
                s.content_id    = s.content_id || matches[3];
                s.station_id    = s.station_id || matches[4];
            }
        }
    );

    $log.debug(`Preparing report for device ${device_id}...`);

    var report =
        new $_table
        ({
            head : [ 'Session ID', 'Message Start', 'Message End', 'LiveDB TAG', 'Station', 'Ad' ]
        });

    var last10 = { };
    session_ids.forEach
    (
        sid =>
        {
            var s       = sessions[sid];
            last10[sid] = s;
            report.push([ sid, s.start_time, s.end_time, s.tag, s.station_id, s.content_id ]);
        }
    );

    $log.info('\n' + report.toString() + '\n');

    return(last10);
}

//------------------------------------------------------------------------------
function print_cv_info(device_id, sessions)
{
    $log.info("Getting Content View data for matched sessions...");
    if( ! Object.keys(sessions).length )
    {
        $log.info("No sessions matched, nothing to get from UAC DB.");
        return;
    }

    $_requestify.get(`http://fh.alphonso.tv/device_views?device_id=${device_id}&limit=10`)
    .then
    (
        results =>
        {
            rows = JSON.parse(results.body);
            $log.debug(`Got ${rows.length} CV records...`);
            if( ! rows || ! rows.length )
            {
                $log.error("No content_view records for matched sessions for this device!");
                $log.error("Note: only the last hour's worth of CV data is queried.");
                return;
            }

            var report =
                new $_table
                ({
                    head : [ 'Session ID', 'Type', 'Title', 'Station', 'Start', 'End' ]
                });

            rows.forEach
            (
                r =>
                {
                	report.push([ r.session_id, r.lookup_type, r.title || r.program_title,
                                    r.network_name || '', r.start_time_first, r.start_time_last ]);
				}
            );

            $log.info('\nContent Views for device:\n' + report.toString() + '\n');
        }
    );
}
